'use strict';

const { Appointment, Doctor, Patient, AuditLog } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { nextSequence } = require('../lib/sequence');
const { dayRange, dateKey, addMinutes, parseDateOnly } = require('../lib/datetime');
const { generateSlots } = require('../lib/availability');
const { canTransition, ACTIVE_STATUSES } = require('../config/appointments');
const reminderService = require('./reminderService');
const patientService = require('./patientService');
const branchService = require('./branchService');
const AppError = require('../utils/AppError');

function apptRepo(ctx) {
  return tenantRepo(Appointment, ctx); // audited (hard rule 7)
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

async function assertSlotFree(ctx, { doctorId, scheduledAt, ignoreId }) {
  const filter = {
    doctorId,
    scheduledAt: new Date(scheduledAt),
    status: { $in: ACTIVE_STATUSES },
  };
  const clash = await apptRepo(ctx).find(filter, { limit: 1 });
  const taken = clash.find((a) => !ignoreId || String(a._id) !== String(ignoreId));
  if (taken) throw new AppError(409, 'That time slot is already booked for this doctor');
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

  await assertSlotFree(ctx, { doctorId, scheduledAt });

  const duration = data.durationMinutes || doctor.slotDurationMinutes || 15;
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
  return appointment;
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
  }
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
    // Reuse an existing patient by EXACT phone/email before creating (avoid duplicates).
    if (data.phone || data.email) {
      const match = await patientService.findByContact(ctx, { phone: data.phone, email: data.email });
      if (match) patientId = match._id;
    }
    if (!patientId) {
      const created = await patientService.createPatient(ctx, { name: data.name, phone: data.phone, email: data.email });
      patientId = created._id;
    }
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
  await assertSlotFree(ctx, { doctorId: appt.doctorId, scheduledAt: newScheduledAt, ignoreId: id });

  const patch = {
    scheduledAt: new Date(newScheduledAt),
    endAt: addMinutes(newScheduledAt, appt.durationMinutes || 15),
  };
  // New day → new per-day token.
  if (dateKey(newScheduledAt) !== dateKey(appt.scheduledAt)) {
    patch.tokenNumber = await nextToken(ctx, appt.branchId, newScheduledAt);
  }
  const updated = await repo.updateById(id, patch);

  // Re-schedule reminders for the new time (upsert reopens existing ones).
  const patient = await tenantRepo(Patient, ctx).findById(updated.patientId);
  if (patient) await reminderService.scheduleAppointmentReminders(ctx, { appointment: updated, patient });
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

/** Bookable slots for a doctor on a date (staff side — no booking lead time). */
async function availableSlots(ctx, { doctorId, date }) {
  const doctor = await loadDoctor(ctx, doctorId);
  const day = date ? parseDateOnly(date) : new Date();
  const { start, end } = dayRange(day);
  const booked = await apptRepo(ctx).find(
    { doctorId, scheduledAt: { $gte: start, $lte: end }, status: { $in: ACTIVE_STATUSES } },
    { lean: true }
  );
  return {
    date: dateKey(day),
    doctorId,
    slots: generateSlots({ doctor, date: day, bookedStarts: booked.map((b) => b.scheduledAt), leadMinutes: 0 }),
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
  availableSlots,
};
