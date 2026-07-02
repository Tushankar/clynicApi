'use strict';

const { Clinic, Patient, MessageLog } = require('../models');
const { planHasFeature } = require('../config/plans');
const commsService = require('./commsService');

/**
 * CRM campaign automations (§5.13) — birthday wishes + follow-up-due reminders, run daily
 * per clinic by the campaign tick (jobs/campaignRunner):
 *
 *   - Plan-gated: CRM_AUTOMATION (Standard + Premium). Basic clinics are skipped entirely.
 *   - Owner-controlled: clinic.crmSettings.{birthdayEnabled, followupEnabled, sendHour}.
 *   - Idempotent: before sending, we check the communications log for a SENT record of the
 *     same template to the same patient today — re-running a tick never double-sends.
 *   - Multi-channel: delivery goes through commsService (email + WhatsApp when available).
 *
 * All sends are recorded in the communications log with sentBy='system'.
 */

const DAY = 24 * 3600 * 1000;

function sysCtx(clinicId) {
  return { clinicId, actorId: 'system', actorRole: 'system' };
}

function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** True if this patient already got `template` today (idempotency via the comms log). */
async function alreadySentToday(clinicId, patientId, template, now) {
  const existing = await MessageLog.findOne({
    clinicId,
    patientId,
    template,
    status: 'sent',
    createdAt: { $gte: startOfDay(now) },
  }).lean();
  return Boolean(existing);
}

function isBirthdayToday(dob, now) {
  if (!dob) return false;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return false;
  return d.getDate() === now.getDate() && d.getMonth() === now.getMonth();
}

/** Send birthday wishes for one clinic. Returns { sent, skipped }. */
async function runBirthdayCampaign(clinic, now = new Date()) {
  const ctx = sysCtx(clinic.clinicId);
  // dob is stored date-only; scan the clinic's patients with a dob (bounded).
  const candidates = await Patient.find({ clinicId: clinic.clinicId, deletedAt: null, dob: { $ne: null } })
    .limit(5000)
    .lean();
  let sent = 0;
  let skipped = 0;
  for (const p of candidates) {
    if (!isBirthdayToday(p.dob, now)) continue;
    if (!p.email && !p.phone) { skipped += 1; continue; }
    if (await alreadySentToday(clinic.clinicId, p._id, 'birthday', now)) { skipped += 1; continue; }
    const res = await commsService.sendCampaignMessage(ctx, clinic, p, 'birthday');
    if (res.channels.some((c) => c.ok)) sent += 1;
    else skipped += 1;
  }
  return { sent, skipped };
}

/** Send follow-up-due reminders for one clinic (followUpAt falls today or is 1 day away). */
async function runFollowupCampaign(clinic, now = new Date()) {
  const ctx = sysCtx(clinic.clinicId);
  const from = startOfDay(now);
  const to = new Date(from.getTime() + 2 * DAY); // today + tomorrow → "due now" window
  const candidates = await Patient.find({
    clinicId: clinic.clinicId,
    deletedAt: null,
    followUpAt: { $gte: from, $lt: to },
  })
    .limit(2000)
    .lean();
  let sent = 0;
  let skipped = 0;
  for (const p of candidates) {
    if (!p.email && !p.phone) { skipped += 1; continue; }
    if (await alreadySentToday(clinic.clinicId, p._id, 'followup', now)) { skipped += 1; continue; }
    const res = await commsService.sendCampaignMessage(ctx, clinic, p, 'followup');
    if (res.channels.some((c) => c.ok)) sent += 1;
    else skipped += 1;
  }
  return { sent, skipped };
}

/**
 * One scheduler tick: run due automations for every entitled clinic whose sendHour has
 * arrived (runs at most once per campaign per day thanks to the per-patient idempotency).
 */
async function runDueCampaigns(now = new Date()) {
  const clinics = await Clinic.find({
    $or: [{ 'crmSettings.birthdayEnabled': true }, { 'crmSettings.followupEnabled': true }],
  }).lean();

  const out = { clinics: 0, birthday: { sent: 0, skipped: 0 }, followup: { sent: 0, skipped: 0 } };
  for (const clinic of clinics) {
    if (!planHasFeature(clinic.subscriptionPlan, 'CRM_AUTOMATION')) continue;
    const hour = clinic.crmSettings?.sendHour ?? 9;
    if (now.getHours() < hour) continue; // not yet time today (idempotency stops repeats after)
    out.clinics += 1;
    if (clinic.crmSettings?.birthdayEnabled) {
      const r = await runBirthdayCampaign(clinic, now).catch(() => ({ sent: 0, skipped: 0 }));
      out.birthday.sent += r.sent;
      out.birthday.skipped += r.skipped;
    }
    if (clinic.crmSettings?.followupEnabled) {
      const r = await runFollowupCampaign(clinic, now).catch(() => ({ sent: 0, skipped: 0 }));
      out.followup.sent += r.sent;
      out.followup.skipped += r.skipped;
    }
  }
  return out;
}

module.exports = { runDueCampaigns, runBirthdayCampaign, runFollowupCampaign, isBirthdayToday };
