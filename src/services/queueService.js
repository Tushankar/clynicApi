'use strict';

const { QueueEntry } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const realtime = require('../realtime/io');
const AppError = require('../utils/AppError');

const AVG_CONSULT_MINUTES = 15;
const ACTIVE = ['waiting', 'called', 'in_consultation'];

function repo(ctx) {
  // Queue entries are high-frequency operational data: tenant-isolated, not audited.
  return tenantRepo(QueueEntry, ctx, { audit: false });
}

function firstName(name) {
  return (name || 'Patient').trim().split(/\s+/)[0];
}

async function getActiveEntries(ctx, branchId) {
  return repo(ctx).find({ branchId, status: { $in: ACTIVE } }, { sort: { tokenNumber: 1, createdAt: 1 }, lean: true });
}

/**
 * Build a queue snapshot. `display: true` returns first-names only (TV / sockets);
 * authenticated reception calls use full names.
 */
async function snapshot(ctx, branchId, { display = false } = {}) {
  const entries = await getActiveEntries(ctx, branchId);
  const serving = entries.filter((e) => e.status === 'in_consultation' || e.status === 'called');
  const waiting = entries.filter((e) => e.status === 'waiting');

  const name = (e) => (display ? firstName(e.patientName) : e.patientName || 'Patient');

  return {
    branchId: String(branchId),
    nowServing: serving.map((e) => ({ id: String(e._id), token: e.tokenNumber, name: name(e), doctorName: e.doctorName, status: e.status })),
    waiting: waiting.map((e, i) => ({
      id: String(e._id),
      token: e.tokenNumber,
      name: name(e),
      doctorName: e.doctorName,
      waitMinutes: (i + 1) * AVG_CONSULT_MINUTES,
    })),
    counts: { waiting: waiting.length, serving: serving.length },
    updatedAt: new Date().toISOString(),
  };
}

async function emit(ctx, branchId) {
  const display = await snapshot(ctx, branchId, { display: true });
  realtime.emitQueueUpdate(ctx.clinicId, branchId, display);
  return display;
}

async function recomputeWaits(ctx, branchId) {
  const waiting = await repo(ctx).find({ branchId, status: 'waiting' }, { sort: { tokenNumber: 1, createdAt: 1 } });
  await Promise.all(
    waiting.map((e, i) => repo(ctx).updateById(e._id, { estimatedWaitMinutes: (i + 1) * AVG_CONSULT_MINUTES }))
  );
}

/** Add an appointment to the queue (idempotent: one entry per appointment). */
async function addEntry(ctx, appointment) {
  const r = repo(ctx);
  const existing = await r.findOne({ appointmentId: appointment._id });
  let entry = existing;
  if (!existing) {
    try {
      entry = await r.create({
        appointmentId: appointment._id,
        branchId: appointment.branchId,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
        patientName: appointment.patientName,
        doctorName: appointment.doctorName,
        tokenNumber: appointment.tokenNumber,
        status: 'waiting',
      });
    } catch (err) {
      if (err.code === 11000) entry = await r.findOne({ appointmentId: appointment._id });
      else throw err;
    }
  }
  await recomputeWaits(ctx, appointment.branchId);
  await emit(ctx, appointment.branchId);
  return entry;
}

async function callNext(ctx, { branchId, doctorId } = {}) {
  if (!branchId) throw new AppError(400, 'branchId is required');
  const r = repo(ctx);
  const filter = { branchId, status: 'waiting' };
  if (doctorId) filter.doctorId = doctorId;
  const next = (await r.find(filter, { sort: { tokenNumber: 1, createdAt: 1 }, limit: 1 }))[0];
  if (!next) throw new AppError(409, 'No one is waiting in the queue');

  const now = new Date();
  const updated = await r.updateById(next._id, { status: 'in_consultation', calledAt: now, startedAt: now });

  // Sync the appointment's status (lazy require avoids a static import cycle).
  const appointmentService = require('./appointmentService');
  await appointmentService.transition(ctx, updated.appointmentId, 'in_consultation', { silent: true }).catch(() => {});

  await recomputeWaits(ctx, branchId);
  const snap = await emit(ctx, branchId);
  // "You're next" for the new front-of-line.
  if (snap.waiting[0]) realtime.emitYourTurn(ctx.clinicId, branchId, { token: snap.waiting[0].token, name: snap.waiting[0].name });
  return updated;
}

async function finishEntry(ctx, entryId, toEntryStatus, toApptStatus) {
  const r = repo(ctx);
  const entry = await r.findById(entryId);
  if (!entry) throw new AppError(404, 'Queue entry not found');
  const updated = await r.updateById(entryId, { status: toEntryStatus, finishedAt: new Date() });
  const appointmentService = require('./appointmentService');
  await appointmentService.transition(ctx, entry.appointmentId, toApptStatus, { silent: true }).catch(() => {});
  await recomputeWaits(ctx, entry.branchId);
  await emit(ctx, entry.branchId);
  return updated;
}

const complete = (ctx, entryId) => finishEntry(ctx, entryId, 'done', 'completed');
const skip = (ctx, entryId) => finishEntry(ctx, entryId, 'skipped', 'no_show');

module.exports = { snapshot, emit, addEntry, callNext, complete, skip, getActiveEntries, AVG_CONSULT_MINUTES };
