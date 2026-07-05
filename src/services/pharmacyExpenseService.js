'use strict';

const { PharmacyExpense, PurchaseOrder, Supplier, Branch } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const branchService = require('./branchService');
const AppError = require('../utils/AppError');

/**
 * Pharmacy expenses (Ultra Premium, §6.7). `purchase` rows are recorded automatically by the GRN
 * (received purchase order); `other` rows are manual. Kept in a dedicated collection, isolated from
 * the main app's Expense/P&L. Money record → audited soft-delete via the tenant repo.
 */
function repo(ctx) {
  return tenantRepo(PharmacyExpense, ctx);
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function list(ctx, { from, to, type } = {}) {
  const filter = {};
  if (type === 'purchase' || type === 'other') filter.type = type;
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

  // KPI totals must cover the WHOLE filtered set, not just the 500-row display page — otherwise the
  // headline pharmacy P&L figures understate outgoings once a range exceeds 500 rows. Clinic-scoped
  // aggregation (tenantRepo has no aggregate(); we scope clinicId + deletedAt explicitly, as analytics does).
  const agg = await PharmacyExpense.aggregate([
    { $match: { clinicId: ctx.clinicId, deletedAt: null, ...filter } },
    { $group: { _id: '$type', amount: { $sum: '$amount' } } },
  ]);
  let total = 0;
  let purchases = 0;
  for (const g of agg) {
    total += g.amount || 0;
    if (g._id === 'purchase') purchases += g.amount || 0;
  }
  total = round2(total);
  purchases = round2(purchases);
  const other = round2(total - purchases);

  // Attach supplier/PO labels for display (tenant-scoped lookups).
  const supIds = [...new Set(items.map((e) => e.supplierId && String(e.supplierId)).filter(Boolean))];
  const poIds = [...new Set(items.map((e) => e.relatedPurchaseOrderId && String(e.relatedPurchaseOrderId)).filter(Boolean))];
  const [sups, pos] = await Promise.all([
    supIds.length ? tenantRepo(Supplier, ctx, { audit: false }).find({ _id: { $in: supIds } }, { lean: true, projection: { name: 1 } }) : [],
    poIds.length ? tenantRepo(PurchaseOrder, ctx, { audit: false }).find({ _id: { $in: poIds } }, { lean: true, projection: { poNumber: 1 } }) : [],
  ]);
  const supById = Object.fromEntries(sups.map((s) => [String(s._id), s.name]));
  const poById = Object.fromEntries(pos.map((p) => [String(p._id), p.poNumber]));
  const decorated = items.map((e) => ({
    ...e,
    supplierName: e.supplierId ? supById[String(e.supplierId)] || null : null,
    poNumber: e.relatedPurchaseOrderId ? poById[String(e.relatedPurchaseOrderId)] || null : null,
  }));
  return { items: decorated, total, purchases, other };
}

/** Manual 'other' expense (purchase expenses are created by the GRN, never here). */
async function create(ctx, body = {}) {
  const amount = round2(body.amount);
  if (!(amount > 0)) throw new AppError(400, 'Amount must be positive');
  const when = new Date(body.date || Date.now());
  if (Number.isNaN(when.getTime())) throw new AppError(400, 'A valid date is required');
  let branch;
  if (body.branchId) {
    branch = await tenantRepo(Branch, ctx, { audit: false }).findById(body.branchId);
    if (!branch) throw new AppError(400, 'Invalid branch');
  } else {
    branch = await branchService.getOrCreatePrimaryBranch(ctx);
  }
  return repo(ctx).create({
    type: 'other',
    amount,
    category: PharmacyExpense.OTHER_CATEGORIES.includes(body.category) ? body.category : 'other',
    note: String(body.note || '').trim().slice(0, 500),
    date: when,
    branchId: branch._id,
    createdBy: ctx.actorId || null,
  });
}

async function remove(ctx, id) {
  const e = await repo(ctx).findById(id);
  if (!e) throw new AppError(404, 'Expense not found');
  // Purchase expenses mirror a received PO — deleting them here would desync the books.
  if (e.type === 'purchase') {
    throw new AppError(400, 'Purchase expenses come from a received purchase order and cannot be deleted here');
  }
  return repo(ctx).softDeleteById(id);
}

module.exports = { list, create, remove, OTHER_CATEGORIES: PharmacyExpense.OTHER_CATEGORIES };
