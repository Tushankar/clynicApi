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
function fmtWhen(date) {
  try {
    return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

/**
 * Booking confirmation (§5.20) — sent right after an online booking or a self-service
 * reschedule, on every available channel. Carries the ticket essentials + the tokenized
 * manage link so the patient can reschedule/cancel without calling. Best-effort: callers
 * fire-and-forget; a failed confirmation never fails the booking.
 */
async function sendBookingConfirmation(ctx, clinic, patient, appointment, { heading = 'Appointment confirmed' } = {}) {
  const publicLinks = require('../lib/publicLinks');
  const selfService = planHasFeature(clinic?.subscriptionPlan, 'SELF_RESCHEDULE');
  const manageUrl = selfService ? publicLinks.manageUrl(ctx.clinicId, appointment._id) : '';

  const dr = appointment.doctorName || 'your doctor';
  const when = fmtWhen(appointment.scheduledAt);
  const subject = `${heading} — ${dr}, ${when}`;
  const text =
    `Hi ${patient.name || 'there'},\n\n` +
    `Your appointment at ${clinic?.name || 'the clinic'} is ${heading === 'Appointment confirmed' ? 'confirmed' : 'updated'}:\n\n` +
    `Doctor: ${dr}\nWhen: ${when}` +
    (appointment.tokenNumber != null ? `\nToken: #${appointment.tokenNumber}` : '') +
    (clinic?.address ? `\nWhere: ${clinic.address}` : '') +
    (manageUrl ? `\n\nNeed to change it? Reschedule or cancel online (up to 2 hours before):\n${manageUrl}` : '') +
    `\n\nSee you soon,\nTeam ${clinic?.name || 'the clinic'}`;

  const ctas = manageUrl ? [{ href: manageUrl, label: 'Manage appointment' }] : undefined;
  const html = templates.wrapHtml(clinic, { title: heading, text, ctas });
  const logBase = { patientId: patient._id, patientName: patient.name, template: 'booking_confirmation', subject };
  const results = [];

  if (patient.email) {
    try {
      await sendNotification({ channel: 'email', to: patient.email, subject, message: text, html, attachments: await templates.emailAttachments(clinic, 'generic') });
      await messageLog.record(ctx, { ...logBase, channel: 'email', to: patient.email, status: 'sent' });
      results.push({ channel: 'email', ok: true });
    } catch (err) {
      await messageLog.record(ctx, { ...logBase, channel: 'email', to: patient.email, status: 'failed', error: err.message });
      results.push({ channel: 'email', ok: false, error: err.message });
    }
  }
  if (whatsappReady(clinic, patient)) {
    try {
      await sendNotification({ channel: 'whatsapp', to: patient.phone, message: `${subject}\n\n${text}` });
      await messageLog.record(ctx, { ...logBase, channel: 'whatsapp', to: patient.phone, status: 'sent' });
      results.push({ channel: 'whatsapp', ok: true });
    } catch (err) {
      await messageLog.record(ctx, { ...logBase, channel: 'whatsapp', to: patient.phone, status: 'failed', error: err.message });
      results.push({ channel: 'whatsapp', ok: false, error: err.message });
    }
  }
  return { channels: results, skipped: results.length === 0, manageUrl };
}

/**
 * Cancellation notice (§5.20) — sent to the patient when their appointment is cancelled, whether
 * the clinic cancelled it OR the patient did via the manage link. Historically NEITHER path told
 * the patient (and the clinic-side cancel even deleted the reminder), so patients showed up to a
 * cancelled slot. Best-effort on every available channel; never fails the cancellation.
 */
async function sendCancellationNotice(ctx, clinic, patient, appointment, { reason } = {}) {
  const dr = appointment.doctorName || 'your doctor';
  const when = fmtWhen(appointment.scheduledAt);
  const subject = `Appointment cancelled — ${dr}, ${when}`;
  const rebook = clinic?.phone
    ? `\n\nTo rebook, please call us on ${clinic.phone}.`
    : `\n\nPlease call the clinic to rebook.`;
  const text =
    `Hi ${patient.name || 'there'},\n\n` +
    `Your appointment at ${clinic?.name || 'the clinic'} has been cancelled:\n\n` +
    `Doctor: ${dr}\nWhen: ${when}` +
    (reason ? `\nReason: ${reason}` : '') +
    rebook +
    `\n\n— Team ${clinic?.name || 'the clinic'}`;
  const html = templates.wrapHtml(clinic, { title: 'Appointment cancelled', text });
  const logBase = { patientId: patient._id, patientName: patient.name, template: 'appointment_cancelled', subject };
  const results = [];

  if (patient.email) {
    try {
      await sendNotification({ channel: 'email', to: patient.email, subject, message: text, html, attachments: await templates.emailAttachments(clinic, 'generic') });
      await messageLog.record(ctx, { ...logBase, channel: 'email', to: patient.email, status: 'sent' });
      results.push({ channel: 'email', ok: true });
    } catch (err) {
      await messageLog.record(ctx, { ...logBase, channel: 'email', to: patient.email, status: 'failed', error: err.message });
      results.push({ channel: 'email', ok: false, error: err.message });
    }
  }
  if (whatsappReady(clinic, patient)) {
    try {
      await sendNotification({ channel: 'whatsapp', to: patient.phone, message: `${subject}\n\n${text}` });
      await messageLog.record(ctx, { ...logBase, channel: 'whatsapp', to: patient.phone, status: 'sent' });
      results.push({ channel: 'whatsapp', ok: true });
    } catch (err) {
      await messageLog.record(ctx, { ...logBase, channel: 'whatsapp', to: patient.phone, status: 'failed', error: err.message });
      results.push({ channel: 'whatsapp', ok: false, error: err.message });
    }
  }
  return { channels: results, skipped: results.length === 0 };
}

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

module.exports = { sendCampaignMessage, sendBookingConfirmation, sendCancellationNotice, renderForPatient, whatsappReady };
