'use strict';

const { planHasFeature } = require('../config/plans');
const templates = require('../lib/comms/templates');
const { sendNotification, adapters } = require('./notifications');
const messageLog = require('./messageLogService');

/**
 * Outbound patient communications (§5.13) — ONE place that renders a CRM template and
 * delivers it on EVERY available channel at the same time:
 *   - email (nodemailer) whenever the patient has an email — branded HTML + plain text
 *   - WhatsApp (Baileys) additionally when the clinic's plan allows it, the channel is
 *     paired/connected, and the patient has a phone — never load-bearing, email-first
 *
 * Premium extras (plan-gated here, structurally):
 *   - AI personalization (AI_FEATURES): the template body is rewritten by the AI driver,
 *     then passed through the rule-2 guard (safePatientText) — a blocked/failed rewrite
 *     silently falls back to the plain template. Marketing copy only, never medical.
 *
 * Every attempt (per channel) is recorded in the communications log.
 */

function whatsappReady(clinic, patient) {
  return Boolean(
    planHasFeature(clinic?.subscriptionPlan, 'WHATSAPP_REMINDERS') &&
      typeof adapters.whatsapp.isConnected === 'function' &&
      adapters.whatsapp.isConnected() &&
      patient?.phone
  );
}

/** Render the message for this clinic+patient, applying AI personalization when entitled. */
async function renderForPatient(clinic, patient, kind) {
  const rendered = templates.render(clinic, kind, patient);
  const wantsAi = Boolean(clinic?.crmSettings?.aiPersonalize) && planHasFeature(clinic?.subscriptionPlan, 'AI_FEATURES');
  if (!wantsAi) return { ...rendered, personalized: false };
  try {
    const ai = require('../lib/ai');
    const raw = await ai.personalizeCampaign({ kind, patient: { name: patient?.name }, clinic: { name: clinic?.name, phone: clinic?.phone }, baseText: rendered.text });
    const text = String(raw || '').trim();
    // Rule 2: a rewrite that drifts into anything medical is discarded — template wins.
    // (The branded email shell already carries the "not medical advice" footer.)
    if (!text || ai.guard.looksLikeMedicalAdvice(text)) return { ...rendered, personalized: false };
    const withAi = templates.render(clinic, kind, patient, { bodyTextOverride: text });
    return { ...withAi, personalized: true };
  } catch {
    return { ...rendered, personalized: false }; // AI failure must never block a campaign
  }
}

/**
 * Send one campaign message (kind: birthday | followup | reengage) to a patient on all
 * available channels. Returns { channels: [{channel, ok}], skipped } — throws only when
 * there is NO channel at all to try.
 */
async function sendCampaignMessage(ctx, clinic, patient, kind) {
  const { subject, text, html } = await renderForPatient(clinic, patient, kind);
  const logBase = { patientId: patient._id, patientName: patient.name, template: kind, subject };
  const results = [];

  if (patient.email) {
    try {
      await sendNotification({ channel: 'email', to: patient.email, subject, message: text, html, attachments: await templates.emailAttachments(clinic, kind) });
      await messageLog.record(ctx, { ...logBase, channel: 'email', to: patient.email, status: 'sent' });
      results.push({ channel: 'email', ok: true });
    } catch (err) {
      await messageLog.record(ctx, { ...logBase, channel: 'email', to: patient.email, status: 'failed', error: err.message });
      results.push({ channel: 'email', ok: false, error: err.message });
    }
  }

  if (whatsappReady(clinic, patient)) {
    try {
      await sendNotification({ channel: 'whatsapp', to: patient.phone, message: text });
      await messageLog.record(ctx, { ...logBase, channel: 'whatsapp', to: patient.phone, status: 'sent' });
      results.push({ channel: 'whatsapp', ok: true });
    } catch (err) {
      await messageLog.record(ctx, { ...logBase, channel: 'whatsapp', to: patient.phone, status: 'failed', error: err.message });
      results.push({ channel: 'whatsapp', ok: false, error: err.message });
    }
  }

  return { channels: results, skipped: results.length === 0 };
}

module.exports = { sendCampaignMessage, renderForPatient, whatsappReady };
