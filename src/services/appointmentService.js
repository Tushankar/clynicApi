'use strict';

const { Appointment, Doctor, Patient, Invoice, Clinic, AuditLog } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { nextSequence } = require('../lib/sequence');
const { dayRange, dateKey, addMinutes, parseDateOnly } = require('../lib/datetime');
const { generateSlots, hasWorkingHours, isWithinWorkingHours } = require('../lib/availability');
const { canTransition, ACTIVE_STATUSES } = require('../config/appointments');
const reminderService = require('./reminderService');
const patientService = require('./patientService');
const branchService = require('./branchService');
const AppError = require('../utils/AppError');

function apptRepo(ctx) {
  return tenantRepo(Appointment, ctx); // audited (hard rule 7)
}

function fmtWhen(date) {
  try {
    return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

/** Lightweight, PHI-free staff socket signal so open Appointments/Dashboard views self-refresh. */
function emitApptChanged(ctx, appointment, action) {
  try {
    require('../realtime/io').emitAppointmentEvent(ctx.clinicId, {
      action,
      appointmentId: String(appointment._id),
      branchId: appointment.branchId ? String(appointment.branchId) : null,
    });
  } catch {
    /* sockets are best-effort */
  }
}

/**
 * Tell the PATIENT their appointment changed (cancelled / rescheduled), on every available
 * channel. One shared path for both staff- and patient-initiated changes so neither is silent.
 * Best-effort — never blocks or fails the state change.
 */
async function notifyPatientAppointmentChange(ctx, appointment, kind, { reason } = {}) {
  try {
    const clinic = await Clinic.findOne({ clinicId: ctx.clinicId }).lean();
    const patient = await tenantRepo(Patient, ctx, { audit: false }).findById(appointment.patientId, { lean: true });
    if (!clinic || !patient) return;
    const comms = require('./commsService');
    if (kind === 'cancelled') await comms.sendCancellationNotice(ctx, clinic, patient, appointment, { reason });
    else if (kind === 'rescheduled') await comms.sendBookingConfirmation(ctx, clinic, patient, appointment, { heading: 'Appointment rescheduled' });
  } catch {
    /* patient notice is best-effort */
  }
}

async function loadDoctor(ctx, doctorId) {
  const doctor = await tenantRepo(Doctor, ctx).findById(doctorId);
  if (!doctor) throw new AppError(404, 'Doctor not found');
  if (!doctor.isActive) throw new AppError(409, 'Doctor is not active');
  return doctor;
}

async function loadPatient(ctx, patientId) {
  const patient = await tenantRepo(Patient, ctx).findById(patientId);
  if (!patient) throw new AppError(404, 'Patient not found');
  return patient;
}

/** Per-branch, per-day token number (atomic — no races, no gaps that collide). */
function nextToken(ctx, branchId, when) {
  return nextSequence(ctx.clinicId, `token:${branchId}:${dateKey(when)}`);
}

/**
 * Reject a scheduled booking/reschedule that OVERLAPS an existing active appointment for the same
 * doctor (optionally with a buffer between visits). Previously this compared exact start times
 * only, so 10:00 and 10:15 for a 30-min slot both passed — real double-books slipped through.
 * Walk-ins are exempt (the patient is physically present and staff decided to see them), so this
 * is only enforced on scheduled sources / reschedules.
 */
async function assertSlotFree(ctx, { doctorId, scheduledAt, durationMinutes = 15, bufferMinutes = 0, ignoreId }) {
  const start = new Date(scheduledAt);
  const end = addMinutes(start, durationMinutes);
  const winStart = addMinutes(start, -bufferMinutes).getTime();
  const winEnd = addMinutes(end, bufferMinutes).getTime();
  // Bound the scan to the appointment's own day (appointments don't cross midnight) for one doctor.
  const { start: dayStart, end: dayEnd } = dayRange(start);
  const sameDay = await apptRepo(ctx).find(
    { doctorId, scheduledAt: { $gte: dayStart, $lte: dayEnd }, status: { $in: ACTIVE_STATUSES } },
    { lean: true }
  );
  const clash = sameDay.find((a) => {
    if (ignoreId && String(a._id) === String(ignoreId)) return false;
    const aStart = new Date(a.scheduledAt).getTime();
    const aEnd = a.endAt ? new Date(a.endAt).getTime() : aStart + (a.durationMinutes || 15) * 60000;
    return aStart < winEnd && aEnd > winStart; // interval overlap
  });
  if (clash) throw new AppError(409, 'That time overlaps another appointment for this doctor');
}

/**
 * Book an appointment (online / walk-in / phone). Generates a token, denormalizes
 * display names, and schedules 24h + 2h reminders. Every appointment carries branchId.
 */
async function book(ctx, data) {
  const { doctorId, patientId, scheduledAt, source = 'walkin', reason, notes, prepaid } = data;
  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    throw new AppError(400, 'A valid scheduledAt is required');
  }

  const branch = data.branchId
    ? { _id: data.branchId }
    : await branchService.getOrCreatePrimaryBranch(ctx);
  const [doctor, patient] = await Promise.all([loadDoctor(ctx, doctorId), loadPatient(ctx, patientId)]);

  const duration = data.durationMinutes || doctor.slotDurationMinutes || 15;
  // Slot conflicts, availability blocks (leave/holiday) and the doctor's working hours all veto a
  // scheduled booking server-side — the UI is never the lock. Walk-ins are exempt: the patient is
  // physically present and staff decided to see them, so a doctor's schedule may intentionally overflow.
  if (source !== 'walkin') {
    // Working hours: only enforced when the doctor has actually configured availability, so a
    // doctor with no hours set is not accidentally un-bookable (matches generateSlots, which
    // returns nothing for such a doctor rather than blocking).
    if (hasWorkingHours(doctor) && !isWithinWorkingHours(doctor, scheduledAt)) {
      throw new AppError(409, "That time is outside the doctor's working hours");
    }
    await assertSlotFree(ctx, { doctorId, scheduledAt, durationMinutes: duration, bufferMinutes: doctor.appointmentBufferMinutes || 0 });
    await require('./availabilityBlockService').assertNotBlocked(ctx, { doctorId, scheduledAt, durationMinutes: duration });
  }
  const token = await nextToken(ctx, branch._id, scheduledAt);

  const appointment = await apptRepo(ctx).create({
    branchId: branch._id,
    patientId,
    doctorId,
    patientName: patient.name,
    patientPhone: patient.phone,
    doctorName: doctor.name,
    scheduledAt: new Date(scheduledAt),
    endAt: addMinutes(scheduledAt, duration),
    durationMinutes: duration,
    status: 'booked',
    source,
    tokenNumber: token,
    reason,
    notes,
    prepaid: !!prepaid,
    bookedByStaffId: ctx.actorId && ctx.actorId !== 'public' ? ctx.actorId : null,
  });

  await reminderService.scheduleAppointmentReminders(ctx, { appointment, patient });

  // Retention loops close themselves on a real booking (best-effort, never blocking):
  // open recalls for this patient are done, and any live waitlist spot they held for
  // this doctor+day converts to 'booked'.
  closeRetentionLoops(ctx, { patient, doctorId, scheduledAt }).catch(() => {});

  // Surface INBOUND self-service bookings (online / phone / portal / whatsapp) to the front
  // desk in real time — reception was previously blind to these until a manual refresh. Walk-ins
  // are created at the desk, so they need no bell. Best-effort — never blocks the booking.
  if (source !== 'walkin') {
    require('./notificationService')
      .emit(ctx, { type: 'appointment_booked', message: `New ${source} booking: ${patient.name || 'patient'} with ${doctor.name}, ${fmtWhen(appointment.scheduledAt)}`, link: '/appointments' })
      .catch(() => {});
  }
  emitApptChanged(ctx, appointment, 'created');

  return appointment;
}

/** Mark open recalls 'booked' + convert the patient's waitlist entry (§5.21/5.22). */
async function closeRetentionLoops(ctx, { patient, doctorId, scheduledAt }) {
  const { Recall, WaitlistEntry } = require('../models');
  await Recall.updateMany(
    { clinicId: ctx.clinicId, patientId: patient._id, status: { $in: ['scheduled', 'sent'] }, deletedAt: null },
    { $set: { status: 'booked' } }
  );

  const contactOr = [];
  const phoneDigits = String(patient.phone || '').replace(/\D/g, '').slice(-10);
  if (phoneDigits) contactOr.push({ phone: { $regex: `${phoneDigits}$` } });
  if (patient.email) contactOr.push({ email: String(patient.email).toLowerCase() });
  if (!contactOr.length) return;
  const { start, end } = dayRange(scheduledAt);
  await WaitlistEntry.updateMany(
    { clinicId: ctx.clinicId, doctorId, date: { $gte: start, $lte: end }, status: { $in: ['waiting', 'notified'] }, $or: contactOr },
    { $set: { status: 'booked' } }
  );
}

/**
 * Bump a patient's visit-tracking fields when an appointment completes (§5.13 / 5.9).
 * Clinic-scoped update; auto-tags 'repeat' from the 2nd completed visit onward so the
 * CRM segment/tag is real. Best-effort — a counter hiccup must not fail the transition.
 */
async function recordVisitCompleted(ctx, patientId, visitedAt) {
  if (!patientId) return;
  try {
    const updated = await Patient.findOneAndUpdate(
      { clinicId: ctx.clinicId, _id: patientId, deletedAt: null },
      { $inc: { visitCount: 1 }, $set: { lastVisitAt: visitedAt || new Date() } },
      { new: true }
    );
    if (!updated) return;
    if (updated.visitCount >= 2 && !(updated.tags || []).includes('repeat')) {
      await Patient.updateOne({ clinicId: ctx.clinicId, _id: patientId }, { $addToSet: { tags: 'repeat' } });
    }
    // Rule 7: a patient write must be audited. The atomic $inc keeps concurrency-safe counts,
    // so we record the audit entry explicitly rather than via the read-then-save tenant repo.
    await AuditLog.create({
      clinicId: ctx.clinicId,
      actorId: ctx.actorId || null,
      actorRole: ctx.actorRole || null,
      action: 'update',
      entityType: 'Patient',
      entityId: patientId,
      before: { visitCount: updated.visitCount - 1 },
      after: { visitCount: updated.visitCount, lastVisitAt: updated.lastVisitAt },
    });
  } catch {
    /* denormalized counter — never block the clinical transition on it */
  }
}

/** Validate + apply a status transition (state machine, section 6/9). */
async function transition(ctx, id, toStatus, { reason } = {}) {
  const repo = apptRepo(ctx);
  const appt = await repo.findById(id);
  if (!appt) throw new AppError(404, 'Appointment not found');
  if (appt.status === toStatus) return appt; // idempotent

  if (!canTransition(appt.status, toStatus)) {
    throw new AppError(409, `Cannot change status from ${appt.status} to ${toStatus}`);
  }
  const patch = { status: toStatus };
  if (toStatus === 'cancelled' || toStatus === 'no_show') {
    if (reason) patch.cancelledReason = reason;
  }
  const updated = await repo.updateById(id, patch);

  const notify = require('./notificationService');
  if (toStatus === 'cancelled' || toStatus === 'no_show') {
    await reminderService.cancelAppointmentReminders(ctx, id);
    notify.emit(ctx, { type: 'appointment_cancelled', message: `Appointment ${toStatus.replace('_', '-')}: ${updated.patientName || 'patient'}`, link: '/appointments' }).catch(() => {});
  } else if (toStatus === 'confirmed') {
    notify.emit(ctx, { type: 'appointment_confirmed', message: `Appointment confirmed: ${updated.patientName || 'patient'}`, link: '/appointments' }).catch(() => {});
  } else if (toStatus === 'completed') {
    // Maintain the CRM/retention denormalized fields (§5.13) that power lapsed/repeat/
    // analytics. System-managed counters — not audited per-bump (like queue/notifications).
    await recordVisitCompleted(ctx, updated.patientId, updated.scheduledAt);
    // Post-visit review ask (§5.21) — plan/toggle-gated inside; never blocks the transition.
    reminderService.scheduleReviewRequest(ctx, { appointment: updated }).catch(() => {});
  }
  emitApptChanged(ctx, updated, toStatus);
  return updated;
}

/** Check a patient in → appointment 'checked_in' + add to the live queue. */
async function checkIn(ctx, id) {
  const appt = await transition(ctx, id, 'checked_in');
  const queueService = require('./queueService'); // lazy: avoids static import cycle
  const queueEntry = await queueService.addEntry(ctx, appt);
  return { appointment: appt, queueEntry };
}

/**
 * Register a walk-in: find-or-create the patient, book now, and check in immediately
 * (they're physically present), so they land in the queue with a token.
 */
async function registerWalkIn(ctx, data) {
  let patientId = data.patientId;
  if (!patientId) {
    if (!data.name) throw new AppError(400, 'Patient name (or patientId) is required');
    // Find-or-create with family-safety: reuse an existing patient on a normalized contact match,
    // but create a distinct record when the same phone/email belongs to a clearly different person
    // (shared household number — a parent registering a child), so histories never merge.
    const { patient } = await patientService.findOrCreatePatient(ctx, { name: data.name, phone: data.phone, email: data.email });
    patientId = patient._id;
  }

  const appt = await book(ctx, {
    doctorId: data.doctorId,
    patientId,
    branchId: data.branchId,
    scheduledAt: data.scheduledAt || new Date(),
    source: 'walkin',
    reason: data.reason,
  });

  const queueService = require('./queueService');
  await transition(ctx, appt._id, 'checked_in');
  const fresh = await apptRepo(ctx).findById(appt._id);
  const queueEntry = await queueService.addEntry(ctx, fresh);
  return { appointment: fresh, queueEntry };
}

async function reschedule(ctx, id, newScheduledAt) {
  const repo = apptRepo(ctx);
  const appt = await repo.findById(id);
  if (!appt) throw new AppError(404, 'Appointment not found');
  if (!ACTIVE_STATUSES.includes(appt.status)) {
    throw new AppError(409, `Cannot reschedule a ${appt.status} appointment`);
  }
  if (!newScheduledAt || Number.isNaN(new Date(newScheduledAt).getTime())) {
    throw new AppError(400, 'A valid scheduledAt is required');
  }
  const duration = appt.durationMinutes || 15;
  const doctor = await tenantRepo(Doctor, ctx, { audit: false }).findById(appt.doctorId, { lean: true });

  // Same server-side guards as book(): no overlap, not inside a leave/holiday block, and within
  // the doctor's working hours. This closes the reschedule-into-leave hole (the block check used
  // to run only on book, so staff — and patients via the manage link — could move a visit into a
  // day the doctor was off).
  if (doctor && hasWorkingHours(doctor) && !isWithinWorkingHours(doctor, newScheduledAt)) {
    throw new AppError(409, "That time is outside the doctor's working hours");
  }
  await assertSlotFree(ctx, { doctorId: appt.doctorId, scheduledAt: newScheduledAt, durationMinutes: duration, bufferMinutes: (doctor && doctor.appointmentBufferMinutes) || 0, ignoreId: id });
  await require('./availabilityBlockService').assertNotBlocked(ctx, { doctorId: appt.doctorId, scheduledAt: newScheduledAt, durationMinutes: duration });

  const patch = {
    scheduledAt: new Date(newScheduledAt),
    endAt: addMinutes(newScheduledAt, duration),
  };
  // New day → new per-day token.
  if (dateKey(newScheduledAt) !== dateKey(appt.scheduledAt)) {
    patch.tokenNumber = await nextToken(ctx, appt.branchId, newScheduledAt);
  }
  const updated = await repo.updateById(id, patch);

  // If the patient is already in the live queue (checked in), keep the queue in sync with the new
  // token/time so the TV and the appointment book don't disagree.
  if (patch.tokenNumber != null) {
    try {
      const qRepo = tenantRepo(require('../models').QueueEntry, ctx, { audit: false });
      const qentry = await qRepo.findOne({ appointmentId: id });
      if (qentry && ['waiting', 'called', 'in_consultation'].includes(qentry.status)) {
        await qRepo.updateById(qentry._id, { tokenNumber: patch.tokenNumber });
        await require('./queueService').emit(ctx, qentry.branchId);
      }
    } catch {
      /* queue sync is best-effort */
    }
  }

  // Cancel the OLD reminders first, THEN schedule fresh ones. Without this, an offset whose new
  // send time is already in the past is skipped by the scheduler, leaving the original reminder
  // (with the OLD time in its text) armed to fire — telling the patient to come at the old time.
  await reminderService.cancelAppointmentReminders(ctx, id).catch(() => {});
  const patient = await tenantRepo(Patient, ctx).findById(updated.patientId);
  if (patient) await reminderService.scheduleAppointmentReminders(ctx, { appointment: updated, patient });

  // Tell the patient the new time in writing (best-effort). One shared path for staff- AND
  // patient-initiated reschedules, so a staff reschedule is no longer silent.
  notifyPatientAppointmentChange(ctx, updated, 'rescheduled').catch(() => {});

  // The OLD slot just freed up — offer it to the waitlist (§5.21). Awaited so it
  // deterministically runs within the request; never fatal to the reschedule.
  try {
    await require('./waitlistService').notifyFreedSlot(ctx, { doctorId: appt.doctorId, doctorName: appt.doctorName, scheduledAt: appt.scheduledAt });
  } catch {
    /* best-effort — a notify failure must not fail the reschedule */
  }
  emitApptChanged(ctx, updated, 'rescheduled');
  return updated;
}

async function cancel(ctx, id, reason) {
  const updated = await transition(ctx, id, 'cancelled', { reason });
  // Pull from the queue if they were checked in.
  const queueService = require('./queueService');
  const entry = await tenantRepo(require('../models').QueueEntry, ctx, { audit: false }).findOne({ appointmentId: id });
  if (entry && ['waiting', 'called'].includes(entry.status)) {
    await queueService.skip(ctx, entry._id).catch(() => {});
  }
  // Tell the PATIENT their appointment was cancelled (best-effort) — covers both a clinic-side
  // cancel and a patient self-cancel via the manage link. Previously neither told the patient,
  // and the clinic-side path even deleted their reminder, so they'd show up to a cancelled slot.
  notifyPatientAppointmentChange(ctx, updated, 'cancelled', { reason }).catch(() => {});

  // The slot just freed up — offer it to the waitlist (§5.21). Awaited so it
  // deterministically runs within the request; never fatal to the cancellation.
  try {
    await require('./waitlistService').notifyFreedSlot(ctx, { doctorId: updated.doctorId, doctorName: updated.doctorName, scheduledAt: updated.scheduledAt });
  } catch {
    /* best-effort — a notify failure must not fail the cancel */
  }
  emitApptChanged(ctx, updated, 'cancelled');
  return updated;
}

async function softDelete(ctx, id) {
  const deleted = await apptRepo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Appointment not found');
  await reminderService.cancelAppointmentReminders(ctx, id);
  return deleted;
}

async function getById(ctx, id) {
  const appt = await apptRepo(ctx).findById(id);
  if (!appt) throw new AppError(404, 'Appointment not found');
  return appt;
}

async function list(ctx, { date, from, to, doctorId, status, branchId, patientId } = {}) {
  const filter = {};
  if (doctorId) filter.doctorId = doctorId;
  if (branchId) filter.branchId = branchId;
  if (patientId) filter.patientId = patientId;
  if (status) filter.status = status;

  if (from || to) {
    filter.scheduledAt = {};
    if (from) filter.scheduledAt.$gte = new Date(from);
    if (to) filter.scheduledAt.$lte = new Date(to);
  } else {
    // Default to the given day (or today).
    const { start, end } = dayRange(date || new Date());
    filter.scheduledAt = { $gte: start, $lte: end };
  }

  return apptRepo(ctx).find(filter, { sort: { scheduledAt: 1 }, lean: true });
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * List appointments + a per-row BILLING summary (§5.9) so the front desk sees money at a
 * glance: expected fee, amount paid, dues, and a payment state. One extra doctors query
 * (fee lookup) and one invoices query (join by appointmentId) — no N+1.
 *
 *   status: 'paid' | 'partial' | 'unpaid' (has an invoice) · 'prepaid' (paid online, no invoice)
 *           · 'none' (nothing billed yet — `due` is the expected consultation fee)
 */
async function listWithBilling(ctx, query = {}) {
  const items = await list(ctx, query);
  if (!items.length) return items;

  const doctorIds = [...new Set(items.map((a) => String(a.doctorId)).filter(Boolean))];
  const apptIds = items.map((a) => a._id);
  const [doctors, invoices] = await Promise.all([
    tenantRepo(Doctor, ctx, { audit: false }).find({ _id: { $in: doctorIds } }, { projection: { consultationFee: 1 }, lean: true }),
    tenantRepo(Invoice, ctx, { audit: false }).find({ appointmentId: { $in: apptIds } }, { lean: true }),
  ]);
  const feeByDoctor = new Map(doctors.map((d) => [String(d._id), d.consultationFee || 0]));
  const invByAppt = new Map();
  for (const inv of invoices) {
    const k = String(inv.appointmentId);
    const cur = invByAppt.get(k) || { total: 0, amountPaid: 0, invoiceId: null };
    cur.total = round2(cur.total + (inv.total || 0));
    cur.amountPaid = round2(cur.amountPaid + (inv.amountPaid || 0));
    cur.invoiceId = cur.invoiceId || String(inv._id);
    invByAppt.set(k, cur);
  }

  return items.map((a) => {
    const fee = feeByDoctor.get(String(a.doctorId)) || 0;
    const inv = invByAppt.get(String(a._id));
    let billing;
    if (inv) {
      const due = round2(inv.total - inv.amountPaid);
      billing = {
        fee,
        invoiceId: inv.invoiceId,
        billed: inv.total,
        paid: inv.amountPaid,
        due: Math.max(0, due),
        status: due <= 0 && inv.total > 0 ? 'paid' : inv.amountPaid > 0 ? 'partial' : 'unpaid',
      };
    } else if (a.prepaid) {
      billing = { fee, invoiceId: null, billed: fee, paid: fee, due: 0, status: 'prepaid' };
    } else {
      billing = { fee, invoiceId: null, billed: fee, paid: 0, due: fee, status: 'none' };
    }
    return { ...a, billing };
  });
}

/** Bookable slots for a doctor on a date (staff side — no booking lead time). */
async function availableSlots(ctx, { doctorId, date }) {
  const doctor = await loadDoctor(ctx, doctorId);
  const day = date ? parseDateOnly(date) : new Date();
  const { start, end } = dayRange(day);
  const [booked, blocks] = await Promise.all([
    apptRepo(ctx).find(
      { doctorId, scheduledAt: { $gte: start, $lte: end }, status: { $in: ACTIVE_STATUSES } },
      { lean: true }
    ),
    require('./availabilityBlockService').blocksFor(ctx, { doctorId, from: start, to: end }),
  ]);
  return {
    date: dateKey(day),
    doctorId,
    slots: generateSlots({ doctor, date: day, bookedStarts: booked.map((b) => b.scheduledAt), leadMinutes: 0, blocks }),
  };
}

module.exports = {
  book,
  transition,
  checkIn,
  registerWalkIn,
  reschedule,
  cancel,
  softDelete,
  getById,
  list,
  listWithBilling,
  availableSlots,
};
