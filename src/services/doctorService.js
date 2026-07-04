'use strict';

const { clerkClient } = require('@clerk/express');
const { Doctor, Staff } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { limitsForPlan } = require('../config/plans');
const config = require('../config/env');
const AppError = require('../utils/AppError');

const WRITABLE = [
  'name',
  'specialization',
  'consultationFee',
  'followUpFee',
  'availability',
  'slotDurationMinutes',
  'appointmentBufferMinutes',
  'color',
  'isActive',
  'staffId',
  // Public profile fields (§5.19)
  'photoUrl',
  'qualifications',
  'experienceYears',
  'registrationNumber',
  'bio',
  'services',
  'languages',
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

/**
 * Resolve a Clerk user id to this clinic's Staff._id, provisioning the Staff row if needed, so a
 * created/edited Doctor can be linked to a login account (staff.clerkUserId → doctor.staffId).
 * That link is what makes resolveCurrentDoctor / the doctor dashboard work for a signed-in doctor.
 */
async function resolveStaffIdForClerkUser(ctx, clerkUserId) {
  if (!clerkUserId) return undefined;
  const repo = tenantRepo(Staff, ctx, { audit: false });
  let staff = await repo.findOne({ clerkUserId });
  if (!staff) staff = await repo.create({ clerkUserId, role: 'doctor' });
  return staff._id;
}

async function createDoctor(ctx, plan, data) {
  const repo = tenantRepo(Doctor, ctx);
  const payload = pick(data);
  if (!payload.name) throw new AppError(400, 'Doctor name is required');
  // New doctors are always active; a plan "seat" is an active doctor (hard rule 5).
  // Forcing isActive here prevents staging inactive doctors to dodge the cap, then flipping them on.
  payload.isActive = true;

  // Optional: link this doctor to a staff login (for the doctor dashboard / "my patients").
  if (data.linkClerkUserId) payload.staffId = await resolveStaffIdForClerkUser(ctx, data.linkClerkUserId);

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

  // Fees are a pricing decision — OWNER ONLY (consistent with the app's money-sensitive
  // RBAC: refunds, plan changes, exports are all owner-gated). The receptionist UI disables
  // these inputs; this is the real server-side lock (hard rules 4 + 5).
  if (ctx.actorRole !== 'owner') {
    delete payload.consultationFee;
    delete payload.followUpFee;
  }

  // Optional: (re)link this doctor to a staff login account.
  if (data.linkClerkUserId !== undefined) {
    payload.staffId = data.linkClerkUserId ? await resolveStaffIdForClerkUser(ctx, data.linkClerkUserId) : null;
  }

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

/**
 * Staff directory for the "link to a login" picker on the doctor form. Returns each clinic member
 * with their doctor-link status. Uses the Clerk org membership list for real names when available
 * (prod), falling back to the JIT-provisioned Staff rows (dev-auth / Clerk unreachable).
 */
async function staffDirectory(ctx) {
  const doctors = await tenantRepo(Doctor, ctx).find({}, { lean: true });
  const linkedStaffIds = new Set(doctors.map((d) => d.staffId && String(d.staffId)).filter(Boolean));
  const staffRows = await tenantRepo(Staff, ctx, { audit: false }).find({}, { lean: true });
  const staffByClerk = new Map(staffRows.map((s) => [s.clerkUserId, s]));

  const fromStaffRows = () =>
    staffRows.map((s) => ({
      clerkUserId: s.clerkUserId,
      name: s.name || `User ${String(s.clerkUserId).slice(-6)}`,
      role: s.role,
      staffId: String(s._id),
      linked: linkedStaffIds.has(String(s._id)),
    }));

  if (config.devAuth) return fromStaffRows();

  try {
    const result = await clerkClient.organizations.getOrganizationMembershipList({ organizationId: ctx.clinicId, limit: 100 });
    const memberships = result.data || result;
    const items = memberships
      .map((m) => {
        const uid = m.publicUserData?.userId;
        const s = uid ? staffByClerk.get(uid) : null;
        return {
          clerkUserId: uid,
          name: [m.publicUserData?.firstName, m.publicUserData?.lastName].filter(Boolean).join(' ') || m.publicUserData?.identifier || 'Team member',
          role: m.role,
          staffId: s ? String(s._id) : null,
          linked: s ? linkedStaffIds.has(String(s._id)) : false,
        };
      })
      .filter((u) => u.clerkUserId);
    return items.length ? items : fromStaffRows();
  } catch {
    return fromStaffRows();
  }
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

module.exports = { listDoctors, getDoctor, createDoctor, updateDoctor, resolveCurrentDoctor, getDashboard, staffDirectory };
