'use strict';

const { WaitlistEntry, Doctor, Clinic } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { dayRange, parseDateOnly, dateKey } = require('../lib/datetime');
const { planHasFeature } = require('../config/plans');
const { sendNotification } = require('./notifications');
const { whatsappReady } = require('./commsService');
const emailTemplates = require('../lib/comms/templates');
const publicLinks = require('../lib/publicLinks');
const messageLog = require('./messageLogService');
const branchService = require('./branchService');
const AppError = require('../utils/AppError');

/**
 * Cancellation waitlist (§5.21, Standard+). Patients who found no slot leave their
 * contact for a doctor+day. When a booking for that doctor+day frees up (cancel or
 * reschedule-away), the first few WAITING entries get a "slot opened" message with
 * the booking link — first come, first served. Never load-bearing: notification
 * failures are logged, the queue itself is the record.
 */

const NOTIFY_BATCH = 3; // how many waiting patients hear about one freed slot

function repo(ctx, { audit = true } = {}) {
  return tenantRepo(WaitlistEntry, ctx, { audit });
}

const digits = (s) => String(s || '').replace(/\D/g, '');

/** Public: join the waitlist for a doctor + day (rate-limited at the route). */
async function joinPublic(clinic, { doctorId, date, name, phone, email } = {}) {
  if (!planHasFeature(clinic.subscriptionPlan, 'WAITLIST')) throw new AppError(404, 'Not available');
  const ctx = { clinicId: clinic.clinicId, actorId: 'public', actorRole: null };

  if (!name || !String(name).trim()) throw new AppError(400, 'Your name is required');
  if (!phone && !email) throw new AppError(400, 'A phone number or email is required so we can reach you');

  const doctor = await tenantRepo(Doctor, ctx).findById(doctorId);
  if (!doctor || !doctor.isActive) throw new AppError(404, 'Doctor not found');

  const day = parseDateOnly(date || dateKey(new Date()));
  const { start, end } = dayRange(day);
  if (end < new Date()) throw new AppError(400, 'That date has already passed');

  // One live entry per contact per doctor+day — joining twice just confirms the spot.
  const dupFilter = {
    doctorId: doctor._id,
    date: start,
    status: { $in: ['waiting', 'notified'] },
    $or: [
      ...(phone ? [{ phone: { $regex: `${digits(phone).slice(-10)}$` } }] : []),
      ...(email ? [{ email: String(email).toLowerCase().trim() }] : []),
    ],
  };
  const existing = await repo(ctx, { audit: false }).findOne(dupFilter, { lean: true });
  if (existing) return { id: String(existing._id), status: existing.status, already: true };

  const branch = await branchService.getOrCreatePrimaryBranch(ctx);
  const entry = await repo(ctx).create({
    branchId: branch._id,
    doctorId: doctor._id,
    doctorName: doctor.name,
    date: start,
    name: String(name).trim().slice(0, 120),
    phone: String(phone || '').trim().slice(0, 20),
    email: String(email || '').toLowerCase().trim().slice(0, 254),
    status: 'waiting',
    source: 'public',
  });

  require('./notificationService')
    .emit(ctx, { type: 'waitlist_joined', message: `${entry.name} joined the waitlist for ${doctor.name}`, link: '/dashboard/appointments' })
    .catch(() => {});

  return { id: String(entry._id), status: 'waiting', already: false };
}

/** Staff: list entries (defaults to today-and-future live entries). */
function list(ctx, { date, doctorId, status, includePast = false } = {}) {
  const filter = {};
  if (doctorId) filter.doctorId = doctorId;
  if (status) filter.status = status;
  else filter.status = { $in: ['waiting', 'notified'] };
  if (date) {
    const { start, end } = dayRange(date);
    filter.date = { $gte: start, $lte: end };
  } else if (!includePast) {
    filter.date = { $gte: dayRange(new Date()).start };
  }
  return repo(ctx, { audit: false }).find(filter, { sort: { date: 1, createdAt: 1 }, limit: 300, lean: true });
}

async function setStatus(ctx, id, status) {
  if (!['waiting', 'notified', 'booked', 'removed'].includes(status)) throw new AppError(400, 'Invalid status');
  const updated = await repo(ctx).updateById(id, { status });
  if (!updated) throw new AppError(404, 'Waitlist entry not found');
  return updated;
}

function fmtWhen(date) {
  try {
    return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

/**
 * A slot for doctor+time was freed (cancel / reschedule-away). Offer it to the first
 * few WAITING entries for that doctor+day. Best-effort by design — callers fire and
 * forget; every attempt lands in the communications log.
 */
async function notifyFreedSlot(ctx, { doctorId, doctorName, scheduledAt }) {
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime()) || when < new Date()) return { notified: 0 }; // past slots aren't offers

  const clinic = await Clinic.findOne({ clinicId: ctx.clinicId }).lean();
  if (!clinic || !planHasFeature(clinic.subscriptionPlan, 'WAITLIST')) return { notified: 0 };

  const { start, end } = dayRange(when);
  const waiting = await repo(ctx, { audit: false }).find(
    { doctorId, date: { $gte: start, $lte: end }, status: 'waiting' },
    { sort: { createdAt: 1 }, limit: NOTIFY_BATCH, lean: true }
  );
  if (!waiting.length) return { notified: 0 };

  const bookUrl = publicLinks.bookingUrl(clinic.slug);
  const sysCtx = { clinicId: ctx.clinicId, actorId: 'system', actorRole: 'system' };
  const subject = `A slot just opened with ${doctorName || 'the doctor'} — ${clinic.name}`;
  let notified = 0;

  for (const entry of waiting) {
    const text =
      `Hi ${entry.name},\n\n` +
      `Good news — an appointment slot with ${doctorName || 'the doctor'} just opened up on ${fmtWhen(when)} at ${clinic.name}.\n\n` +
      `Slots are first come, first served. Book yours here:\n${bookUrl}\n\n` +
      `Team ${clinic.name}`;

    let delivered = false;
    if (entry.email) {
      try {
        const html = emailTemplates.wrapHtml(clinic, { title: 'A slot just opened up', text });
        await sendNotification({ channel: 'email', to: entry.email, subject, message: text, html, attachments: await emailTemplates.emailAttachments(clinic, 'generic') });
        messageLog.record(sysCtx, { channel: 'email', template: 'waitlist', subject, to: entry.email, status: 'sent' }).catch(() => {});
        delivered = true;
      } catch (err) {
        messageLog.record(sysCtx, { channel: 'email', template: 'waitlist', subject, to: entry.email, status: 'failed', error: err.message }).catch(() => {});
      }
    }
    if (whatsappReady(clinic, { phone: entry.phone })) {
      try {
        await sendNotification({ channel: 'whatsapp', to: entry.phone, message: `${subject}\n\n${text}` });
        messageLog.record(sysCtx, { channel: 'whatsapp', template: 'waitlist', subject, to: entry.phone, status: 'sent' }).catch(() => {});
        delivered = true;
      } catch (err) {
        messageLog.record(sysCtx, { channel: 'whatsapp', template: 'waitlist', subject, to: entry.phone, status: 'failed', error: err.message }).catch(() => {});
      }
    }

    if (delivered) {
      await WaitlistEntry.updateOne(
        { _id: entry._id, clinicId: ctx.clinicId },
        { $set: { status: 'notified', notifiedAt: new Date() } }
      );
      notified += 1;
    }
  }

  // No channel could reach anyone (phone-only entries, WhatsApp offline) → nudge the
  // front desk to fill the slot by phone instead of letting it quietly go to waste.
  if (!notified) {
    require('./notificationService')
      .emit(ctx, {
        type: 'waitlist_slot_freed',
        message: `A slot with ${doctorName || 'a doctor'} freed up on ${fmtWhen(when)} — ${waiting.length} on the waitlist. Call to fill it.`,
        link: '/dashboard/appointments',
      })
      .catch(() => {});
  }

  return { notified };
}

module.exports = { joinPublic, list, setStatus, notifyFreedSlot, NOTIFY_BATCH };
