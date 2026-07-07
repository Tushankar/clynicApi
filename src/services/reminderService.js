'use strict';

const { Reminder, Clinic } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { sendNotification } = require('./notifications');
const { planHasFeature } = require('../config/plans');
const config = require('../config/env');
const { addMinutes } = require('../lib/datetime');

/**
 * Reminder scheduling + delivery (sections 5.4, 9.2).
 *
 * - On booking, schedule two reminders (24h + 2h) — idempotent via an upsert keyed
 *   by (appointmentId, type), so re-running never double-schedules.
 * - Delivery claims a reminder atomically (status scheduled → sent) BEFORE sending,
 *   so concurrent workers/processors can never double-send (9.2 "idempotent").
 * - An optional enqueuer (set by the BullMQ jobs module) schedules a delayed job;
 *   with no Redis, reminders are processed by processDueReminders (poller/manual).
 */

const REMINDER_OFFSETS = [
  { type: 'appointment_24h', minutesBefore: 24 * 60 },
  { type: 'appointment_2h', minutesBefore: 2 * 60 },
];

// Standard Indian dosage slots: a positional "M-A-N" code (e.g. "1-0-1") maps to these times of
// day. Defaults for now — a later enhancement could make them clinic-configurable.
const DOSE_SLOTS = [
  { key: 'morning', hour: 8 },
  { key: 'afternoon', hour: 14 },
  { key: 'night', hour: 20 },
];
const MAX_DOSE_REMINDERS = 90; // bound the horizon (≈30 days × 3/day) so a long course can't flood

/** Parse a "1-0-1" / "1-1-1" dosage code → which daily slots are active. Unknown format → once daily. */
function activeDoseSlots(dosage) {
  const parts = String(dosage || '').split(/[-\s/]+/).filter((p) => p !== '');
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    const active = DOSE_SLOTS.filter((_, i) => Number(parts[i]) > 0);
    return active.length ? active : [DOSE_SLOTS[0]];
  }
  return [DOSE_SLOTS[0]];
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function dateKeyLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Pick the delivery channel + address for a patient: WhatsApp when the clinic is entitled AND the
 * channel is actually connected AND the patient has a phone; otherwise email. WhatsApp is never
 * load-bearing. Mirrors the logic in scheduleAppointmentReminders/scheduleReviewRequest.
 */
function resolvePatientChannel(clinic, patient) {
  const { adapters } = require('./notifications');
  const waConnected = typeof adapters.whatsapp.isConnected === 'function' ? adapters.whatsapp.isConnected() : Boolean(config.whatsapp.enabled);
  const whatsappAvailable = planHasFeature(clinic?.subscriptionPlan, 'WHATSAPP_REMINDERS') && config.whatsapp.enabled && waConnected;
  if (whatsappAvailable && patient?.phone) return { channel: 'whatsapp', to: patient.phone };
  return { channel: 'email', to: patient?.email || null };
}

let enqueuer = async () => {};
function setEnqueuer(fn) {
  enqueuer = typeof fn === 'function' ? fn : async () => {};
}

function formatWhen(date) {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

function buildMessage({ patientName, doctorName, scheduledAt, manageUrl }) {
  const when = formatWhen(scheduledAt);
  const dr = doctorName || 'your doctor';
  return {
    subject: `Appointment reminder — ${dr}`,
    message:
      `Hi ${patientName || 'there'}, this is a reminder of your appointment with ${dr} on ${when}.` +
      (manageUrl
        ? `\n\nNeed to change it? Reschedule or cancel online (up to 2 hours before):\n${manageUrl}`
        : ' Please reply to confirm or reschedule.'),
  };
}

/**
 * Create/refresh the 24h + 2h reminders for an appointment (idempotent).
 * Email-only in Phase 1; skipped if the patient has no email or the time has passed.
 */
async function scheduleAppointmentReminders(ctx, { appointment, patient, now = new Date() }) {
  // Channel is PLAN-GATED (§6.5 / 10.5): WhatsApp (Std/Prem) is used only when the clinic is
  // ENTITLED, the WhatsApp channel is actually ENABLED (Baileys — never route to a disabled
  // channel), and the patient has a phone. Otherwise email. WhatsApp is never load-bearing —
  // email is the graceful fallback. clinicId comes from ctx (tenant-scoped).
  const clinic = await Clinic.findOne({ clinicId: ctx.clinicId }).lean();
  const { adapters } = require('./notifications');
  const waConnected = typeof adapters.whatsapp.isConnected === 'function' ? adapters.whatsapp.isConnected() : Boolean(config.whatsapp.enabled);
  const whatsappAvailable = planHasFeature(clinic?.subscriptionPlan, 'WHATSAPP_REMINDERS') && config.whatsapp.enabled && waConnected;
  let channel = 'email';
  let to = patient?.email || null;
  if (whatsappAvailable && patient?.phone) {
    channel = 'whatsapp';
    to = patient.phone;
  }
  if (!to) return [];

  // Self-service manage link (§5.20) — minted once, reused by both reminders.
  const manageUrl = planHasFeature(clinic?.subscriptionPlan, 'SELF_RESCHEDULE')
    ? require('../lib/publicLinks').manageUrl(ctx.clinicId, appointment._id)
    : '';

  const { subject, message } = buildMessage({
    patientName: patient.name,
    doctorName: appointment.doctorName,
    scheduledAt: appointment.scheduledAt,
    manageUrl,
  });

  const created = [];
  for (const off of REMINDER_OFFSETS) {
    const sendAt = addMinutes(appointment.scheduledAt, -off.minutesBefore);
    if (sendAt <= now) continue; // too late to schedule this one

    const filter = { clinicId: ctx.clinicId, appointmentId: appointment._id, type: off.type };

    // Never re-open an already-delivered reminder — re-opening + re-arming would
    // double-send the same reminder document on a reschedule-after-send (9.2).
    const existing = await Reminder.findOne(filter).lean();
    if (existing && existing.status === 'sent') continue;

    const update = {
      // payload keeps BOTH contacts: delivery mirrors to the second channel when available
      // (email + WhatsApp at the same time) and falls back to email if WhatsApp fails.
      $set: { clinicId: ctx.clinicId, patientId: appointment.patientId, channel, sendAt, status: 'scheduled', payload: { to, subject, message, email: patient?.email || null, phone: patient?.phone || null }, error: null, sentAt: null },
    };
    let reminder;
    try {
      reminder = await Reminder.findOneAndUpdate(filter, update, { new: true, upsert: true, setDefaultsOnInsert: true });
    } catch (err) {
      if (err.code === 11000) {
        // Lost the insert race against a concurrent identical schedule — converge on the winner.
        reminder = await Reminder.findOneAndUpdate(filter, update, { new: true });
      } else throw err;
    }
    if (!reminder) continue;
    created.push(reminder);
    try {
      await enqueuer(reminder); // BullMQ delayed job if Redis-backed; otherwise no-op
    } catch {
      /* enqueue failure is non-fatal — the poller/manual processor still covers it */
    }
  }
  return created;
}

async function cancelAppointmentReminders(ctx, appointmentId) {
  await Reminder.updateMany(
    { clinicId: ctx.clinicId, appointmentId, status: 'scheduled' },
    { $set: { status: 'cancelled' } }
  );
}

// How long after a completed visit the review ask goes out — long enough to feel
// considerate, short enough that the visit is fresh.
const REVIEW_REQUEST_DELAY_MINUTES = 120;

/**
 * Schedule the post-visit review request (§5.21) for a just-completed appointment.
 * Rides the same Reminder machinery (unique {appointmentId, type} → idempotent;
 * atomic claim on delivery → never double-sends). Plan- and toggle-gated; a repeat
 * completion (or re-run) is a no-op via appointment.reviewRequestSentAt.
 */
async function scheduleReviewRequest(ctx, { appointment, now = new Date() }) {
  if (!appointment || appointment.reviewRequestSentAt) return null;
  const clinic = await Clinic.findOne({ clinicId: ctx.clinicId }).lean();
  if (!clinic) return null;
  if (!planHasFeature(clinic.subscriptionPlan, 'REVIEW_REQUESTS')) return null;
  if (!clinic.crmSettings?.reviewRequestEnabled) return null;

  const { Patient } = require('../models');
  const patient = await Patient.findOne({ clinicId: ctx.clinicId, _id: appointment.patientId, deletedAt: null }).lean();
  if (!patient || (!patient.email && !patient.phone)) return null;

  const { adapters } = require('./notifications');
  const waConnected = typeof adapters.whatsapp.isConnected === 'function' ? adapters.whatsapp.isConnected() : Boolean(config.whatsapp.enabled);
  const whatsappAvailable = planHasFeature(clinic.subscriptionPlan, 'WHATSAPP_REMINDERS') && config.whatsapp.enabled && waConnected;
  let channel = 'email';
  let to = patient.email || null;
  if (whatsappAvailable && patient.phone) {
    channel = 'whatsapp';
    to = patient.phone;
  }
  if (!to) return null;

  const reviewUrl = require('../lib/publicLinks').reviewUrl(ctx.clinicId, appointment._id);
  const dr = appointment.doctorName || 'your doctor';
  const subject = `How was your visit to ${clinic.name}?`;
  const message =
    `Hi ${patient.name || 'there'}, thank you for visiting ${clinic.name} today.\n\n` +
    `How was your visit with ${dr}? It takes 30 seconds to rate it — your feedback helps us and other patients:\n${reviewUrl}\n\n` +
    `Warm regards,\nTeam ${clinic.name}`;

  const filter = { clinicId: ctx.clinicId, appointmentId: appointment._id, type: 'review_request' };
  const update = {
    $set: {
      clinicId: ctx.clinicId,
      patientId: appointment.patientId,
      channel,
      sendAt: addMinutes(now, REVIEW_REQUEST_DELAY_MINUTES),
      status: 'scheduled',
      payload: { to, subject, message, email: patient.email || null, phone: patient.phone || null },
      error: null,
      sentAt: null,
    },
  };
  let reminder;
  try {
    reminder = await Reminder.findOneAndUpdate(filter, update, { new: true, upsert: true, setDefaultsOnInsert: true });
  } catch (err) {
    if (err.code === 11000) reminder = await Reminder.findOne(filter);
    else throw err;
  }
  if (!reminder) return null;

  // Mark the ask as initiated so repeat completions don't re-open it.
  const { Appointment } = require('../models');
  await Appointment.updateOne({ clinicId: ctx.clinicId, _id: appointment._id }, { $set: { reviewRequestSentAt: new Date() } });

  try {
    await enqueuer(reminder);
  } catch {
    /* poller covers it */
  }
  return reminder;
}

/**
 * Schedule "take your medicine" reminders for a dosage schedule (§6.5). This is the piece that was
 * missing: remindersEnabled was collected at dispense time but nothing ever read it, so no dosage
 * reminder was ever sent. Creates one Reminder per active dose-slot per day across the course
 * [startDate, endDate], reusing the SAME delivery machinery (atomic claim → no double-send) and
 * channel selection as appointment reminders. Each occurrence gets a unique `type`
 * (dose:<scheduleId>:<date>:<slot>) so re-runs are idempotent and the unique {appointmentId,type}
 * index never collides (dosage reminders carry no appointmentId). Best-effort — never throws.
 */
async function scheduleDosageReminders(ctx, schedule, { now = new Date() } = {}) {
  try {
    if (!schedule || !schedule.remindersEnabled) return [];
    const clinic = await Clinic.findOne({ clinicId: ctx.clinicId }).lean();
    const { Patient } = require('../models');
    const patient = await Patient.findOne({ clinicId: ctx.clinicId, _id: schedule.patientId, deletedAt: null }).lean();
    if (!clinic || !patient) return [];

    const { channel, to } = resolvePatientChannel(clinic, patient);
    if (!to) return [];

    const slots = activeDoseSlots(schedule.dosage);
    const start = schedule.startDate ? new Date(schedule.startDate) : new Date(now);
    const end = schedule.endDate
      ? new Date(schedule.endDate)
      : schedule.durationDays
        ? new Date(start.getTime() + schedule.durationDays * 24 * 3600 * 1000)
        : new Date(start);

    // Enumerate future (day × slot) occurrences from the later of course-start / today, capped.
    const occurrences = [];
    const cursor = new Date(Math.max(start.getTime(), startOfDay(now).getTime()));
    for (let d = new Date(cursor); d <= end && occurrences.length < MAX_DOSE_REMINDERS; d.setDate(d.getDate() + 1)) {
      for (const slot of slots) {
        const sendAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), slot.hour, 0, 0, 0);
        if (sendAt > now) occurrences.push({ sendAt, slotKey: slot.key, dateKey: dateKeyLocal(d) });
      }
    }
    if (occurrences.length >= MAX_DOSE_REMINDERS) {
      console.warn(`[reminderService] dosage reminders capped at ${MAX_DOSE_REMINDERS} for schedule ${schedule._id}`);
    }

    const med = schedule.medicineName || 'your medicine';
    const timing = schedule.timing ? ` (${schedule.timing})` : '';
    const subject = `Medicine reminder — ${med}`;
    const message = `Hi ${patient.name || 'there'}, it's time to take ${med}${schedule.dosage ? ` [${schedule.dosage}]` : ''}${timing}. Take care!`;

    const created = [];
    for (const occ of occurrences.slice(0, MAX_DOSE_REMINDERS)) {
      const type = `dose:${schedule._id}:${occ.dateKey}:${occ.slotKey}`;
      const filter = { clinicId: ctx.clinicId, type };
      const update = {
        $set: {
          clinicId: ctx.clinicId,
          patientId: schedule.patientId,
          channel,
          sendAt: occ.sendAt,
          status: 'scheduled',
          payload: { to, subject, message, email: patient.email || null, phone: patient.phone || null },
          error: null,
          sentAt: null,
        },
      };
      let reminder;
      try {
        reminder = await Reminder.findOneAndUpdate(filter, update, { new: true, upsert: true, setDefaultsOnInsert: true });
      } catch (err) {
        if (err.code === 11000) reminder = await Reminder.findOne(filter);
        else throw err;
      }
      if (!reminder) continue;
      created.push(reminder);
      try {
        await enqueuer(reminder);
      } catch {
        /* poller covers it */
      }
    }
    return created;
  } catch (err) {
    console.error('[reminderService] scheduleDosageReminders failed:', err?.message || err);
    return [];
  }
}

/**
 * Atomically claim a reminder and deliver it once. Returns 'sent' | 'failed' | 'skipped'.
 * Delivery is multi-channel: the stored primary channel first; then a best-effort MIRROR on
 * the other channel when it's actually usable (email + WhatsApp at the same time, §10.5).
 * If the primary is WhatsApp and it fails, email is the fallback — WhatsApp is never
 * load-bearing. Every channel attempt lands in the communications log.
 */
async function _deliver(reminderId, now = new Date()) {
  const claimed = await Reminder.findOneAndUpdate(
    { _id: reminderId, status: 'scheduled' },
    { $set: { status: 'sent', sentAt: now } },
    { new: true }
  );
  if (!claimed) return 'skipped'; // already handled — guarantees no double-send
  const sysCtx = { clinicId: claimed.clinicId, actorId: 'system', actorRole: 'system' };
  const template = ['appointment_24h', 'appointment_2h', 'review_request'].includes(claimed.type) ? claimed.type : 'custom';
  const messageLog = require('./messageLogService');
  const { adapters } = require('./notifications');
  const { subject, message } = claimed.payload;

  // Branded HTML shell for the email variant (best-effort — plain text always included).
  const clinic = await Clinic.findOne({ clinicId: claimed.clinicId }).lean().catch(() => null);
  const emailTemplates = require('../lib/comms/templates');
  const html = clinic ? emailTemplates.wrapHtml(clinic, { title: subject, text: message }) : undefined;
  const attachments = clinic ? await emailTemplates.emailAttachments(clinic, 'generic') : undefined;

  const emailTo = claimed.channel === 'email' ? claimed.payload.to : claimed.payload.email;
  const phoneTo = claimed.channel === 'whatsapp' ? claimed.payload.to : claimed.payload.phone;
  const waUsable = config.whatsapp.enabled && (typeof adapters.whatsapp.isConnected !== 'function' || adapters.whatsapp.isConnected());

  const sendEmail = async () => {
    await sendNotification({ channel: 'email', to: emailTo, subject, message, html, attachments });
    messageLog.record(sysCtx, { patientId: claimed.patientId, channel: 'email', template, subject, to: emailTo, status: 'sent' }).catch(() => {});
  };
  const sendWhatsapp = async () => {
    await sendNotification({ channel: 'whatsapp', to: phoneTo, message: `${subject}\n\n${message}` });
    messageLog.record(sysCtx, { patientId: claimed.patientId, channel: 'whatsapp', template, subject, to: phoneTo, status: 'sent' }).catch(() => {});
  };

  try {
    // Primary channel (as scheduled).
    if (claimed.channel === 'whatsapp') {
      let emailDone = false;
      try {
        await sendWhatsapp();
      } catch (waErr) {
        // WhatsApp is never load-bearing — fall back to email when we have an address.
        messageLog.record(sysCtx, { patientId: claimed.patientId, channel: 'whatsapp', template, subject, to: phoneTo, status: 'failed', error: waErr.message }).catch(() => {});
        if (!emailTo) throw waErr;
        await sendEmail();
        emailDone = true;
      }
      // Mirror: patient also has an email → send it there too (kept in sync, same content).
      if (emailTo && !emailDone) await sendEmail().catch(() => {});
    } else {
      await sendEmail();
      // Mirror: WhatsApp additionally when the channel is truly usable + patient has a phone.
      if (phoneTo && waUsable) await sendWhatsapp().catch(() => {});
    }

    // In-app notification feed event (best-effort).
    require('./notificationService')
      .emit({ clinicId: claimed.clinicId, actorId: null, actorRole: null }, { type: 'reminder_sent', message: `Reminder sent to ${claimed.payload.to}`, link: '/appointments' })
      .catch(() => {});
    return 'sent';
  } catch (err) {
    await Reminder.updateOne({ _id: reminderId }, { $set: { status: 'failed', error: String(err.message).slice(0, 500) } });
    messageLog.record(sysCtx, { patientId: claimed.patientId, channel: claimed.channel, template, subject, to: claimed.payload.to, status: 'failed', error: err.message }).catch(() => {});
    // Proactively surface the failure to staff — a silently-failed reminder is a preventable no-show.
    require('./notificationService')
      .emit(sysCtx, { type: 'reminder_failed', message: `A reminder to ${claimed.payload.to} failed to send — the patient may not have been reminded.`, link: '/dashboard/communications' })
      .catch(() => {});
    return 'failed';
  }
}

/** Worker entrypoint (BullMQ job → this). */
async function processOneReminder(reminderId) {
  return _deliver(reminderId);
}

/** Send all reminders whose time has come. Used by the dev poller and tests. */
async function processDueReminders({ clinicId = null, now = new Date(), limit = 200 } = {}) {
  const filter = { status: 'scheduled', sendAt: { $lte: now } };
  if (clinicId) filter.clinicId = clinicId;
  const due = await Reminder.find(filter).limit(limit).lean();
  let sent = 0;
  let failed = 0;
  for (const r of due) {
    const result = await _deliver(r._id, now);
    if (result === 'sent') sent += 1;
    else if (result === 'failed') failed += 1;
  }
  return { processed: due.length, sent, failed };
}

/** List reminders for the clinic (optionally for one appointment) — tenant-scoped. */
function listReminders(ctx, { appointmentId, status, limit = 100 } = {}) {
  const filter = {};
  if (appointmentId) filter.appointmentId = appointmentId;
  if (status) filter.status = status;
  return tenantRepo(Reminder, ctx, { audit: false }).find(filter, { sort: { sendAt: 1 }, limit, lean: true });
}

module.exports = {
  REMINDER_OFFSETS,
  setEnqueuer,
  scheduleAppointmentReminders,
  scheduleReviewRequest,
  scheduleDosageReminders,
  cancelAppointmentReminders,
  processOneReminder,
  processDueReminders,
  listReminders,
};
