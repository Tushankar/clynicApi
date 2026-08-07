'use strict';

const { Expense } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const branchService = require('./branchService');
const AppError = require('../utils/AppError');

/**
 * Expense tracking (§5.23, Premium) — clinic outgoings that power the P&L view in
 * analytics. Financial records: audited via the tenant repo, soft-deleted only.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function repo(ctx) {
  return tenantRepo(Expense, ctx); // audited (money)
}

async function list(ctx, { from, to, category, branchId } = {}) {
  const filter = {};
  if (category) filter.category = category;
  if (branchId) filter.branchId = branchId;
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) {
      // Inclusive end-of-day: a date-only 'to' would otherwise exclude same-day expenses (which
      // carry a real timestamp), silently dropping a full day from the period totals.
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      filter.date.$lte = end;
    }
  }
  const items = await repo(ctx).find(filter, { sort: { date: -1 }, limit: 500, lean: true });

  // The total must cover the WHOLE filtered set, not just the 500-row display page. Reducing over
  // `items` meant a clinic past 500 expenses saw an under-reported "Total recorded" presented as
  // authoritative. Clinic-scoped aggregation (tenantRepo exposes no aggregate(), so clinicId +
  // deletedAt are scoped explicitly here, exactly as analyticsService does).
  // This mirrors the fix already applied in pharmacyExpenseService.
  const agg = await Expense.aggregate([
    { $match: { clinicId: ctx.clinicId, deletedAt: null, ...filter } },
    { $group: { _id: null, amount: { $sum: '$amount' } } },
  ]);
  const total = round2(agg[0]?.amount || 0);
  return { items, total, truncated: items.length >= 500 };
}

async function create(ctx, { date, category, description, amount, method, note, branchId } = {}) {
  const amt = round2(amount);
  if (!(amt > 0)) throw new AppError(400, 'Amount must be positive');
  if (!description || !String(description).trim()) throw new AppError(400, 'A description is required');
  const when = new Date(date || Date.now());
  if (Number.isNaN(when.getTime())) throw new AppError(400, 'A valid date is required');

  const branch = branchId ? { _id: branchId } : await branchService.getOrCreatePrimaryBranch(ctx);
  return repo(ctx).create({
    branchId: branch._id,
    date: when,
    category: Expense.CATEGORIES.includes(category) ? category : 'other',
    description: String(description).trim().slice(0, 200),
    amount: amt,
    method: ['cash', 'upi', 'card', 'bank', 'other'].includes(method) ? method : 'cash',
    note: String(note || '').trim().slice(0, 500),
    createdBy: ctx.actorId || null,
  });
}

async function remove(ctx, id) {
  const deleted = await repo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Expense not found');
  return deleted;
}

module.exports = { list, create, remove, CATEGORIES: Expense.CATEGORIES };
