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

function buildMessage({ patientName, doctorName, scheduledAt }) {
  const when = formatWhen(scheduledAt);
  const dr = doctorName || 'your doctor';
  return {
    subject: `Appointment reminder — ${dr}`,
    message: `Hi ${patientName || 'there'}, this is a reminder of your appointment with ${dr} on ${when}. Please reply to confirm or reschedule.`,
  };
}

/**
 * Create/refresh the 24h + 2h reminders for an appointment (idempotent).
 * Email-only in Phase 1; skipped if the patient has no email or the time has passed.
 */
async function scheduleAppointmentReminders(ctx, { appointment, patient, now = new Date() }) {
  // Channel is PLAN-GATED (§6.5 / 10.5): WhatsApp (Std/Prem) is used only when the clinic is
  // ENTITLED, the WhatsApp channel is actually CONFIGURED (cloud driver — never route to an
  // unconfigured mock in prod), and the patient has a phone. Otherwise email. WhatsApp is
  // never load-bearing — email is the graceful fallback. clinicId comes from ctx (tenant-scoped).
  const clinic = await Clinic.findOne({ clinicId: ctx.clinicId }).lean();
  const whatsappAvailable = planHasFeature(clinic?.subscriptionPlan, 'WHATSAPP_REMINDERS') && config.whatsapp.driver === 'cloud';
  let channel = 'email';
  let to = patient?.email || null;
  if (whatsappAvailable && patient?.phone) {
    channel = 'whatsapp';
    to = patient.phone;
  }
  if (!to) return [];

  const { subject, message } = buildMessage({
    patientName: patient.name,
    doctorName: appointment.doctorName,
    scheduledAt: appointment.scheduledAt,
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
      $set: { clinicId: ctx.clinicId, patientId: appointment.patientId, channel, sendAt, status: 'scheduled', payload: { to, subject, message }, error: null, sentAt: null },
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

/** Atomically claim a reminder and deliver it once. Returns 'sent' | 'failed' | 'skipped'. */
async function _deliver(reminderId, now = new Date()) {
  const claimed = await Reminder.findOneAndUpdate(
    { _id: reminderId, status: 'scheduled' },
    { $set: { status: 'sent', sentAt: now } },
    { new: true }
  );
  if (!claimed) return 'skipped'; // already handled — guarantees no double-send
  try {
    await sendNotification({
      channel: claimed.channel,
      to: claimed.payload.to,
      subject: claimed.payload.subject,
      message: claimed.payload.message,
    });
    // In-app notification feed event (best-effort).
    require('./notificationService')
      .emit({ clinicId: claimed.clinicId, actorId: null, actorRole: null }, { type: 'reminder_sent', message: `Reminder sent to ${claimed.payload.to}`, link: '/appointments' })
      .catch(() => {});
    return 'sent';
  } catch (err) {
    await Reminder.updateOne({ _id: reminderId }, { $set: { status: 'failed', error: String(err.message).slice(0, 500) } });
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
  cancelAppointmentReminders,
  processOneReminder,
  processDueReminders,
  listReminders,
};
