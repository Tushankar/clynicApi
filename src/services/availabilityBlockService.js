'use strict';

const { AvailabilityBlock, Doctor, Appointment } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { ACTIVE_STATUSES } = require('../config/appointments');
const AppError = require('../utils/AppError');

/**
 * Availability blocks (§5.20) — doctor leave, clinic holidays, ad-hoc blocks.
 * The slot engine consults these when offering slots, and appointmentService
 * consults them again at booking time (defense in depth: the UI is never the lock).
 */

function repo(ctx) {
  return tenantRepo(AvailabilityBlock, ctx); // audited schedule config
}

/** Blocks that overlap [from, to) for one doctor (their own + clinic-wide ones). */
async function blocksFor(ctx, { doctorId, from, to }) {
  const filter = {
    startAt: { $lt: new Date(to) },
    endAt: { $gt: new Date(from) },
    ...(doctorId ? { $or: [{ doctorId: null }, { doctorId }] } : {}),
  };
  return tenantRepo(AvailabilityBlock, ctx, { audit: false }).find(filter, { sort: { startAt: 1 }, lean: true });
}

/** Throw 409 when the proposed appointment window falls inside a block. */
async function assertNotBlocked(ctx, { doctorId, scheduledAt, durationMinutes = 15 }) {
  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const clash = await tenantRepo(AvailabilityBlock, ctx, { audit: false }).findOne(
    {
      startAt: { $lt: end },
      endAt: { $gt: start },
      $or: [{ doctorId: null }, { doctorId }],
    },
    { lean: true }
  );
  if (clash) {
    const label = clash.doctorId ? 'The doctor is unavailable' : 'The clinic is closed';
    throw new AppError(409, `${label} at that time${clash.reason ? ` (${clash.reason})` : ''}`);
  }
}

/** Upcoming (and optionally past) blocks for the dashboard list. */
function list(ctx, { doctorId, includePast = false } = {}) {
  const filter = {};
  if (doctorId) filter.doctorId = doctorId;
  if (!includePast) filter.endAt = { $gte: new Date() };
  return tenantRepo(AvailabilityBlock, ctx, { audit: false }).find(filter, { sort: { startAt: 1 }, limit: 200, lean: true });
}

/**
 * Create a block. Returns the block plus how many ACTIVE appointments fall inside
 * it, so the front desk knows who to call and reschedule — creating a block never
 * silently cancels anything.
 */
async function create(ctx, { doctorId, startAt, endAt, reason, type } = {}) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new AppError(400, 'Valid start and end times are required');
  if (end <= start) throw new AppError(400, 'End must be after start');

  let doctorName = '';
  let docId = null;
  if (doctorId) {
    const doctor = await tenantRepo(Doctor, ctx).findById(doctorId);
    if (!doctor) throw new AppError(404, 'Doctor not found');
    doctorName = doctor.name;
    docId = doctor._id;
  }

  const block = await repo(ctx).create({
    doctorId: docId,
    doctorName,
    startAt: start,
    endAt: end,
    reason: (reason || '').trim(),
    type: ['leave', 'holiday', 'block'].includes(type) ? type : docId ? 'leave' : 'holiday',
    createdBy: ctx.actorId || null,
  });

  const impactFilter = {
    scheduledAt: { $gte: start, $lt: end },
    status: { $in: ACTIVE_STATUSES },
    ...(docId ? { doctorId: docId } : {}),
  };
  const impactedRows = await tenantRepo(Appointment, ctx, { audit: false }).find(impactFilter, { sort: { scheduledAt: 1 }, limit: 200, lean: true });
  const impacted = impactedRows.length;

  // Creating a block never auto-cancels anything, but leaving the affected patients silent is how
  // people end up travelling to a closed clinic. Raise a PERSISTENT staff notification (not just a
  // toast), CANCEL those appointments' pending reminders (so no "come in" reminder fires for a
  // closed clinic while staff decide), and hand the caller the actionable list + a one-click
  // cancel-and-notify path (cancelImpacted below).
  if (impacted > 0) {
    const who = doctorName ? `${doctorName}'s ${block.type}` : `The ${block.type}`;
    require('./notificationService')
      .emit(ctx, {
        type: 'availability_block_impact',
        message: `${who} overlaps ${impacted} booked appointment${impacted === 1 ? '' : 's'} — cancel & notify, or reschedule ${impacted === 1 ? 'it' : 'them'}.`,
        link: '/dashboard/time-off',
      })
      .catch(() => {});
    const reminderService = require('./reminderService');
    for (const a of impactedRows) reminderService.cancelAppointmentReminders(ctx, a._id).catch(() => {});
  }

  return {
    block,
    impactedAppointments: impacted,
    impacted: impactedRows.map((a) => ({
      id: String(a._id),
      patientId: String(a.patientId),
      patientName: a.patientName || '',
      doctorId: a.doctorId ? String(a.doctorId) : null,
      doctorName: a.doctorName || '',
      scheduledAt: a.scheduledAt,
      tokenNumber: a.tokenNumber ?? null,
    })),
  };
}

async function remove(ctx, id) {
  const deleted = await repo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Block not found');
  return deleted;
}

/**
 * One-click "cancel & notify" for the patients booked inside a leave/holiday block. Cancels every
 * active appointment in the block's window via appointmentService.cancel — which now messages each
 * patient, cancels their reminders, and offers the freed slot to the waitlist. Returns the count.
 */
async function cancelImpacted(ctx, blockId, reason) {
  const block = await tenantRepo(AvailabilityBlock, ctx, { audit: false }).findById(blockId, { lean: true });
  if (!block) throw new AppError(404, 'Block not found');
  const filter = {
    scheduledAt: { $gte: new Date(block.startAt), $lt: new Date(block.endAt) },
    status: { $in: ACTIVE_STATUSES },
    ...(block.doctorId ? { doctorId: block.doctorId } : {}),
  };
  const rows = await tenantRepo(Appointment, ctx, { audit: false }).find(filter, { lean: true });
  const appointmentService = require('./appointmentService');
  const msg = reason || (block.doctorName ? `${block.doctorName} is unavailable` : 'The clinic is closed') + ' at this time';
  let cancelled = 0;
  for (const a of rows) {
    try {
      await appointmentService.cancel(ctx, a._id, msg);
      cancelled += 1;
    } catch {
      /* keep going — one failure shouldn't stop the batch */
    }
  }
  return { cancelled };
}

module.exports = { blocksFor, assertNotBlocked, list, create, remove, cancelImpacted };
