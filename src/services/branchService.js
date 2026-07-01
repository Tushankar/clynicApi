'use strict';

const { Branch, Appointment } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { limitsForPlan } = require('../config/plans');
const { ACTIVE_STATUSES } = require('../config/appointments');
const AppError = require('../utils/AppError');

// System reads / auto-provisioning: not audited (avoids noise on getOrCreatePrimaryBranch).
function repo(ctx) {
  return tenantRepo(Branch, ctx, { audit: false });
}
// Owner-initiated branch config changes ARE audited (hard rule 7).
function auditedRepo(ctx) {
  return tenantRepo(Branch, ctx);
}

function listBranches(ctx) {
  return repo(ctx).find({}, { sort: { isPrimary: -1, createdAt: 1 }, lean: true });
}

/** Every clinic has at least one branch; create a primary one on first use (hard rule 8). */
async function getOrCreatePrimaryBranch(ctx) {
  const r = repo(ctx);
  let branch = await r.findOne({ isPrimary: true });
  if (!branch) branch = await r.findOne({});
  if (!branch) branch = await r.create({ name: 'Main branch', isPrimary: true });
  return branch;
}

/**
 * Create a branch (owner + MULTI_BRANCH). Enforces the plan's branch limit (rule 5)
 * defensively — even though the route is Premium-gated and Premium is unlimited.
 */
async function createBranch(ctx, plan, data) {
  if (!data?.name) throw new AppError(400, 'Branch name is required');
  const max = limitsForPlan(plan).maxBranches;
  const current = await repo(ctx).count({});
  if (current >= max) {
    throw new AppError(403, `Your plan allows up to ${max} branch(es). Upgrade to add more.`, { error: 'limit_reached', limit: max });
  }
  // First branch in a clinic is primary by construction.
  const isPrimary = current === 0;
  return auditedRepo(ctx).create({ name: data.name, address: data.address, phone: data.phone, isPrimary });
}

async function updateBranch(ctx, id, data) {
  const patch = {};
  for (const k of ['name', 'address', 'phone']) if (data[k] !== undefined) patch[k] = data[k];
  const updated = await auditedRepo(ctx).updateById(id, patch);
  if (!updated) throw new AppError(404, 'Branch not found');
  return updated;
}

/**
 * Soft-delete (retire) a branch. Guards: never remove the primary branch, and never
 * remove a branch that still has active appointments — reassign/close them first. This
 * keeps operational data (which references branchId) consistent (hard rules 6 + 8).
 */
async function deleteBranch(ctx, id) {
  const branch = await repo(ctx).findById(id);
  if (!branch) throw new AppError(404, 'Branch not found');
  if (branch.isPrimary) throw new AppError(400, 'The primary branch cannot be removed. Set another branch as primary first.');

  const activeCount = await tenantRepo(Appointment, ctx).count({ branchId: id, status: { $in: ACTIVE_STATUSES } });
  if (activeCount > 0) {
    throw new AppError(409, `This branch has ${activeCount} active appointment(s). Complete or move them before removing it.`);
  }
  return auditedRepo(ctx).softDeleteById(id);
}

module.exports = { listBranches, getOrCreatePrimaryBranch, createBranch, updateBranch, deleteBranch };
