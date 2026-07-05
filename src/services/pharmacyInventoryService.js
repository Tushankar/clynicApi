'use strict';

const { Medicine, InventoryBatch, Branch } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const branchService = require('./branchService');
const alertService = require('./pharmacyAlertService');
const AppError = require('../utils/AppError');

/**
 * Pharmacy inventory (Ultra Premium, §6.3). Physical stock as per-branch batches; live
 * availability is computed on read (tenantRepo has no aggregate()). Stock/financial record →
 * audited soft-delete via the tenant repo. Every batch write re-checks stock-health alerts.
 */
const { NEAR_EXPIRY_DAYS } = alertService;
const DAY_MS = 24 * 60 * 60 * 1000;

function repo(ctx) {
  return tenantRepo(InventoryBatch, ctx); // audited (stock/financial)
}
function medicineRepo(ctx) {
  return tenantRepo(Medicine, ctx, { audit: false }); // read-only lookups here
}

/**
 * Live availability per medicine (one query, grouped in JS). Returns a map keyed by medicine
 * id → { available, expiringSoonQty, expiredQty, batchCount, nearestExpiry }. Expired stock is
 * excluded from `available` (never sellable, §5). Pass { medicineIds } to scope the scan.
 */
async function availabilityMap(ctx, { medicineIds } = {}) {
  const filter = {};
  if (medicineIds && medicineIds.length) filter.medicineId = { $in: medicineIds };
  const batches = await tenantRepo(InventoryBatch, ctx, { audit: false }).find(filter, { lean: true });
  const now = Date.now();
  const soonCutoff = now + NEAR_EXPIRY_DAYS * DAY_MS;
  const map = {};
  for (const b of batches) {
    const id = String(b.medicineId);
    const m = map[id] || (map[id] = { available: 0, expiringSoonQty: 0, expiredQty: 0, batchCount: 0, nearestExpiry: null });
    m.batchCount += 1;
    const qty = b.quantityInStock || 0;
    const exp = b.expiryDate ? new Date(b.expiryDate).getTime() : null;
    if (exp !== null && exp < now) {
      m.expiredQty += qty;
    } else {
      m.available += qty;
      if (exp !== null && exp <= soonCutoff) m.expiringSoonQty += qty;
    }
    if (exp !== null && (m.nearestExpiry === null || exp < m.nearestExpiry)) m.nearestExpiry = exp;
  }
  for (const id of Object.keys(map)) {
    if (map[id].nearestExpiry) map[id].nearestExpiry = new Date(map[id].nearestExpiry);
  }
  return map;
}

function expiryStatus(expiryDate, now = Date.now()) {
  if (!expiryDate) return 'ok';
  const exp = new Date(expiryDate).getTime();
  if (exp < now) return 'expired';
  if (exp <= now + NEAR_EXPIRY_DAYS * DAY_MS) return 'expiring';
  return 'ok';
}

async function listBatches(ctx, { medicineId, branchId } = {}) {
  const filter = {};
  // Coerce to strings so a query-string operator object can't reach the filter (also avoids an
  // ObjectId CastError on a non-string id). Still clinic-scoped by tenantRepo regardless.
  if (typeof medicineId === 'string') filter.medicineId = medicineId;
  if (typeof branchId === 'string') filter.branchId = branchId;
  const batches = await repo(ctx).find(filter, { sort: { expiryDate: 1 }, limit: 1000, lean: true });
  const medIds = [...new Set(batches.map((b) => String(b.medicineId)))];
  const meds = medIds.length
    ? await medicineRepo(ctx).find({ _id: { $in: medIds } }, { lean: true, projection: { name: 1, brand: 1, unit: 1 } })
    : [];
  const medById = Object.fromEntries(meds.map((m) => [String(m._id), m]));
  const now = Date.now();
  const items = batches.map((b) => {
    const m = medById[String(b.medicineId)];
    return {
      ...b,
      medicineName: m?.name || '—',
      medicineBrand: m?.brand || '',
      unit: m?.unit || 'unit',
      expiryStatus: expiryStatus(b.expiryDate, now),
    };
  });
  return { items };
}

async function createBatch(ctx, { medicineId, batchNo, expiryDate, quantityInStock, purchaseUnitCost, branchId } = {}) {
  if (!medicineId) throw new AppError(400, 'A medicine is required');
  const med = await medicineRepo(ctx).findById(medicineId);
  if (!med) throw new AppError(404, 'Medicine not found');
  const exp = new Date(expiryDate);
  if (!expiryDate || Number.isNaN(exp.getTime())) throw new AppError(400, 'A valid expiry date is required');
  const qty = Number(quantityInStock);
  if (!Number.isFinite(qty) || qty < 0) throw new AppError(400, 'Quantity must be zero or more');
  const cost = Number(purchaseUnitCost);
  if (purchaseUnitCost !== undefined && purchaseUnitCost !== '' && (!Number.isFinite(cost) || cost < 0)) {
    throw new AppError(400, 'Cost cannot be negative');
  }
  // Only attach a branch that actually belongs to this clinic — never trust a client branchId
  // (a stale/foreign/typo'd id would create orphaned per-branch stock). Tenant-scoped lookup.
  let branch;
  if (branchId) {
    branch = await tenantRepo(Branch, ctx, { audit: false }).findById(branchId);
    if (!branch) throw new AppError(400, 'Invalid branch');
  } else {
    branch = await branchService.getOrCreatePrimaryBranch(ctx);
  }
  const batch = await repo(ctx).create({
    medicineId,
    branchId: branch._id,
    batchNo: String(batchNo || '').trim().slice(0, 80),
    expiryDate: exp,
    quantityInStock: Math.floor(qty),
    purchaseUnitCost: Number.isFinite(cost) && cost >= 0 ? cost : 0,
    createdBy: ctx.actorId || null,
  });
  alertService.checkMedicine(ctx, String(medicineId)).catch(() => {});
  return batch;
}

async function updateBatch(ctx, id, body = {}) {
  const existing = await repo(ctx).findById(id);
  if (!existing) throw new AppError(404, 'Batch not found');
  const update = {};
  if (body.batchNo !== undefined) update.batchNo = String(body.batchNo || '').trim().slice(0, 80);
  if (body.expiryDate !== undefined) {
    const exp = new Date(body.expiryDate);
    if (Number.isNaN(exp.getTime())) throw new AppError(400, 'A valid expiry date is required');
    update.expiryDate = exp;
  }
  if (body.quantityInStock !== undefined) {
    const qty = Number(body.quantityInStock);
    if (!Number.isFinite(qty) || qty < 0) throw new AppError(400, 'Quantity must be zero or more');
    update.quantityInStock = Math.floor(qty);
  }
  if (body.purchaseUnitCost !== undefined) {
    const cost = Number(body.purchaseUnitCost);
    if (!Number.isFinite(cost) || cost < 0) throw new AppError(400, 'Cost cannot be negative');
    update.purchaseUnitCost = cost;
  }
  const saved = await repo(ctx).updateById(id, update);
  alertService.checkMedicine(ctx, String(existing.medicineId)).catch(() => {});
  return saved;
}

async function removeBatch(ctx, id) {
  const existing = await repo(ctx).findById(id);
  if (!existing) throw new AppError(404, 'Batch not found');
  const deleted = await repo(ctx).softDeleteById(id);
  alertService.checkMedicine(ctx, String(existing.medicineId)).catch(() => {});
  return deleted;
}

/** Inventory overview metrics for the dashboard stat cards. */
async function summary(ctx) {
  const [medicines, batches] = await Promise.all([
    medicineRepo(ctx).find({}, { lean: true, projection: { reorderLevel: 1 } }),
    tenantRepo(InventoryBatch, ctx, { audit: false }).find({}, { lean: true }),
  ]);
  const now = Date.now();
  const soon = now + NEAR_EXPIRY_DAYS * DAY_MS;
  const availByMed = {};
  let stockValue = 0;
  let expiringBatches = 0;
  let expiredBatches = 0;
  for (const b of batches) {
    const qty = b.quantityInStock || 0;
    const exp = b.expiryDate ? new Date(b.expiryDate).getTime() : null;
    if (exp !== null && exp < now) {
      expiredBatches += 1;
    } else {
      availByMed[String(b.medicineId)] = (availByMed[String(b.medicineId)] || 0) + qty;
      stockValue += qty * (b.purchaseUnitCost || 0);
      if (exp !== null && exp <= soon) expiringBatches += 1;
    }
  }
  let lowStockCount = 0;
  for (const m of medicines) {
    if (m.reorderLevel > 0 && (availByMed[String(m._id)] || 0) <= m.reorderLevel) lowStockCount += 1;
  }
  return {
    totalMedicines: medicines.length,
    totalBatches: batches.length,
    stockValue: Math.round(stockValue * 100) / 100,
    lowStockCount,
    expiringBatches,
    expiredBatches,
    nearExpiryDays: NEAR_EXPIRY_DAYS,
  };
}

module.exports = { availabilityMap, listBatches, createBatch, updateBatch, removeBatch, summary, expiryStatus };
