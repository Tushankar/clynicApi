'use strict';

const { Doctor, Staff } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { limitsForPlan } = require('../config/plans');
const AppError = require('../utils/AppError');

const WRITABLE = [
  'name',
  'specialization',
  'consultationFee',
  'availability',
  'slotDurationMinutes',
  'appointmentBufferMinutes',
  'color',
  'isActive',
  'staffId',
];

function pick(data = {}) {
  const out = {};
  for (const k of WRITABLE) if (data[k] !== undefined) out[k] = data[k];
  return out;
}

function listDoctors(ctx, { activeOnly = false } = {}) {
  const repo = tenantRepo(Doctor, ctx);
  return repo.find(activeOnly ? { isActive: true } : {}, { sort: { name: 1 }, lean: true });
}

async function getDoctor(ctx, id) {
  const doc = await tenantRepo(Doctor, ctx).findById(id);
  if (!doc) throw new AppError(404, 'Doctor not found');
  return doc;
}

function limitError(max) {
  return new AppError(403, `Your plan allows up to ${max} active doctor(s). Upgrade to add more.`, {
    error: 'upgrade_required',
    feature: 'maxDoctors',
    limit: max,
  });
}

async function createDoctor(ctx, plan, data) {
  const repo = tenantRepo(Doctor, ctx);
  const payload = pick(data);
  if (!payload.name) throw new AppError(400, 'Doctor name is required');
  // New doctors are always active; a plan "seat" is an active doctor (hard rule 5).
  // Forcing isActive here prevents staging inactive doctors to dodge the cap, then flipping them on.
  payload.isActive = true;

  const max = limitsForPlan(plan).maxDoctors;
  if (Number.isFinite(max) && (await repo.count({ isActive: true })) >= max) throw limitError(max);
  return repo.create(payload);
}

/**
 * Update a doctor. Re-checks the plan cap on any inactive→active transition
 * (the create-only check was bypassable by reactivating a deactivated doctor).
 */
async function updateDoctor(ctx, id, data, plan) {
  const repo = tenantRepo(Doctor, ctx);
  const payload = pick(data);

  if (payload.isActive === true) {
    const existing = await repo.findById(id);
    if (!existing) throw new AppError(404, 'Doctor not found');
    if (!existing.isActive) {
      const max = limitsForPlan(plan).maxDoctors;
      if (Number.isFinite(max) && (await repo.count({ isActive: true })) >= max) throw limitError(max);
    }
  }

  const updated = await repo.updateById(id, payload);
  if (!updated) throw new AppError(404, 'Doctor not found');
  return updated;
}

/** Resolve the Doctor record for the signed-in staff user (staff.clerkUserId → doctor.staffId), or null. */
async function resolveCurrentDoctor(ctx) {
  const staff = await tenantRepo(Staff, ctx, { audit: false }).findOne({ clerkUserId: ctx.actorId });
  if (!staff) return null;
  return tenantRepo(Doctor, ctx).findOne({ staffId: staff._id });
}

/**
 * Doctor dashboard payload (today's appointments for the doctor + the live branch queue).
 * Reuses the appointment/queue services so it stays consistent with the rest of the app.
 */
async function getDashboard(ctx, { doctorId, date } = {}) {
  const appointmentService = require('./appointmentService');
  const queueService = require('./queueService');
  const branchService = require('./branchService');

  const appointments = await appointmentService.list(ctx, { date, doctorId });
  const branch = await branchService.getOrCreatePrimaryBranch(ctx);
  const queue = await queueService.snapshot(ctx, branch._id, { display: false });
  return { appointments, queue, branchId: String(branch._id) };
}

module.exports = { listDoctors, getDoctor, createDoctor, updateDoctor, resolveCurrentDoctor, getDashboard };
