'use strict';

const { PurchaseOrder, Supplier, Medicine, InventoryBatch, PharmacyExpense, Branch } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { nextSequence } = require('../lib/sequence');
const branchService = require('./branchService');
const alertService = require('./pharmacyAlertService');
const AppError = require('../utils/AppError');

/**
 * Purchase orders + goods receipt (GRN) — Ultra Premium, §6.1. Receiving a PO creates inventory
 * batches and records a purchase expense. Money/stock record → audited soft-delete via the tenant
 * repo. The GRN is TRANSACTION-FREE (the deployment's Mongo is standalone; nothing else in the app
 * uses sessions): it uses an idempotent conditional status flip to prevent double-receipt races,
 * and rolls back (removes any batches it created + reverts status) if a step fails, so a retry is clean.
 */
function repo(ctx) {
  return tenantRepo(PurchaseOrder, ctx);
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Validate + normalize line items against the clinic's OWN catalog; snapshot name/unit for history.
async function buildItems(ctx, rawItems, { requireExpiry = false } = {}) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new AppError(400, 'At least one line item is required');
  const ids = [...new Set(rawItems.map((i) => i && i.medicineId).filter(Boolean).map(String))];
  const meds = ids.length ? await tenantRepo(Medicine, ctx, { audit: false }).find({ _id: { $in: ids } }, { lean: true }) : [];
  const medById = Object.fromEntries(meds.map((m) => [String(m._id), m]));
  const items = rawItems.map((it, idx) => {
    const med = medById[String(it.medicineId)];
    if (!med) throw new AppError(400, `Line ${idx + 1}: unknown medicine`);
    const qty = Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty < 1) throw new AppError(400, `Line ${idx + 1}: quantity must be at least 1`);
    const unitCost = Number(it.unitCost);
    if (it.unitCost !== undefined && it.unitCost !== '' && (!Number.isFinite(unitCost) || unitCost < 0)) {
      throw new AppError(400, `Line ${idx + 1}: invalid unit cost`);
    }
    let expiryDate = null;
    if (it.expiryDate) {
      const d = new Date(it.expiryDate);
      if (Number.isNaN(d.getTime())) throw new AppError(400, `Line ${idx + 1}: invalid expiry date`);
      expiryDate = d;
    }
    if (requireExpiry && !expiryDate) throw new AppError(400, `Line ${idx + 1} (${med.name}): an expiry date is required to receive stock`);
    let mfgDate = null;
    if (it.mfgDate) {
      const d = new Date(it.mfgDate);
      if (!Number.isNaN(d.getTime())) mfgDate = d;
    }
    return {
      medicineId: med._id,
      medicineName: med.name,
      unit: med.unit || 'unit',
      qty,
      unitCost: Number.isFinite(unitCost) && unitCost >= 0 ? unitCost : 0,
      batchNo: String(it.batchNo || '').trim().slice(0, 80),
      mfgDate,
      expiryDate,
    };
  });
  const totalCost = round2(items.reduce((s, i) => s + i.qty * i.unitCost, 0));
  return { items, totalCost };
}

async function resolveBranch(ctx, branchId) {
  if (branchId) {
    const b = await tenantRepo(Branch, ctx, { audit: false }).findById(branchId);
    if (!b) throw new AppError(400, 'Invalid branch');
    return b;
  }
  return branchService.getOrCreatePrimaryBranch(ctx);
}

async function list(ctx, { status, supplierId } = {}) {
  const filter = {};
  // Coerce to strings so a query-string operator object (e.g. ?supplierId[$ne]=x) can't reach the
  // Mongo filter as an operator. (Still clinic-scoped by tenantRepo, but keep filters literal.)
  if (typeof status === 'string') filter.status = status;
  if (typeof supplierId === 'string') filter.supplierId = supplierId;
  const items = await repo(ctx).find(filter, { sort: { createdAt: -1 }, limit: 500, lean: true });
  return { items };
}

async function get(ctx, id) {
  const po = await repo(ctx).findById(id, { lean: true });
  if (!po) throw new AppError(404, 'Purchase order not found');
  return po;
}

async function create(ctx, body = {}) {
  if (!body.supplierId) throw new AppError(400, 'A supplier is required');
  const supplier = await tenantRepo(Supplier, ctx, { audit: false }).findById(body.supplierId);
  if (!supplier) throw new AppError(400, 'Unknown supplier');
  const { items, totalCost } = await buildItems(ctx, body.items);
  const branch = await resolveBranch(ctx, body.branchId);
  const seq = await nextSequence(ctx.clinicId, 'purchaseOrder');
  const poNumber = 'PO' + String(seq).padStart(5, '0');
  const status = body.status === 'ordered' ? 'ordered' : 'draft';
  return repo(ctx).create({
    poNumber,
    supplierId: supplier._id,
    supplierName: supplier.name,
    items,
    totalCost,
    status,
    orderedAt: status === 'ordered' ? new Date() : null,
    branchId: branch._id,
    notes: String(body.notes || '').trim().slice(0, 1000),
    createdBy: ctx.actorId || null,
  });
}

async function update(ctx, id, body = {}) {
  const po = await repo(ctx).findById(id);
  if (!po) throw new AppError(404, 'Purchase order not found');
  if (po.status !== 'draft') throw new AppError(400, 'Only draft purchase orders can be edited');
  const update = {};
  if (body.supplierId !== undefined) {
    const s = await tenantRepo(Supplier, ctx, { audit: false }).findById(body.supplierId);
    if (!s) throw new AppError(400, 'Unknown supplier');
    update.supplierId = s._id;
    update.supplierName = s.name;
  }
  if (body.items !== undefined) {
    const { items, totalCost } = await buildItems(ctx, body.items);
    update.items = items;
    update.totalCost = totalCost;
  }
  if (body.notes !== undefined) update.notes = String(body.notes || '').trim().slice(0, 1000);
  return repo(ctx).updateById(id, update);
}

/** Draft → ordered, or cancel (anything not yet received). */
async function setStatus(ctx, id, status) {
  const po = await repo(ctx).findById(id);
  if (!po) throw new AppError(404, 'Purchase order not found');
  if (status === 'ordered') {
    if (po.status !== 'draft') throw new AppError(400, 'Only a draft can be marked as ordered');
    return repo(ctx).updateById(id, { status: 'ordered', orderedAt: new Date() });
  }
  if (status === 'cancelled') {
    if (po.status === 'received') throw new AppError(400, 'A received purchase order cannot be cancelled');
    return repo(ctx).updateById(id, { status: 'cancelled' });
  }
  throw new AppError(400, 'Unsupported status change');
}

/**
 * Receive a PO (GRN): create an inventory batch per line + record the purchase expense, then mark
 * received. Optional body.items supplies/overrides batchNo/expiryDate/mfgDate per line (index-aligned).
 */
async function receive(ctx, id, body = {}) {
  const po = await repo(ctx).findById(id);
  if (!po) throw new AppError(404, 'Purchase order not found');
  if (po.status === 'received') throw new AppError(409, 'This purchase order was already received');
  if (po.status === 'cancelled') throw new AppError(400, 'A cancelled purchase order cannot be received');
  if (!po.items?.length) throw new AppError(400, 'This purchase order has no items');

  // Merge receive-time overrides (batch/expiry finalized on delivery) with the stored lines.
  const overrides = Array.isArray(body.items) ? body.items : [];
  const rawItems = po.items.map((it, idx) => {
    const ov = overrides[idx] || {};
    return {
      medicineId: it.medicineId,
      qty: it.qty,
      unitCost: it.unitCost,
      batchNo: ov.batchNo !== undefined ? ov.batchNo : it.batchNo,
      mfgDate: ov.mfgDate !== undefined ? ov.mfgDate : it.mfgDate,
      expiryDate: ov.expiryDate !== undefined ? ov.expiryDate : it.expiryDate,
    };
  });
  const { items, totalCost } = await buildItems(ctx, rawItems, { requireExpiry: true });

  // Idempotent guard (no transactions): flip status only if it is still what we read. A concurrent
  // receive that already flipped it loses this race and gets a 409 — so stock is never doubled.
  const flipped = await PurchaseOrder.findOneAndUpdate(
    { _id: po._id, clinicId: ctx.clinicId, status: po.status },
    { $set: { status: 'received', receivedAt: new Date(), items, totalCost } },
    { new: true }
  );
  if (!flipped) throw new AppError(409, 'This purchase order is already being received');

  try {
    const batchRepo = tenantRepo(InventoryBatch, ctx);
    for (const it of items) {
      await batchRepo.create({
        medicineId: it.medicineId,
        branchId: po.branchId,
        batchNo: it.batchNo,
        expiryDate: it.expiryDate,
        quantityInStock: it.qty,
        purchaseUnitCost: it.unitCost,
        purchaseOrderId: po._id,
        createdBy: ctx.actorId || null,
      });
    }
    await tenantRepo(PharmacyExpense, ctx).create({
      type: 'purchase',
      amount: totalCost,
      relatedPurchaseOrderId: po._id,
      supplierId: po.supplierId,
      branchId: po.branchId,
      date: new Date(),
      note: `Stock received — ${po.poNumber}`,
      createdBy: ctx.actorId || null,
    });
    for (const mid of [...new Set(items.map((i) => String(i.medicineId)))]) {
      alertService.checkMedicine(ctx, mid).catch(() => {});
    }
    return repo(ctx).findById(po._id, { lean: true });
  } catch (err) {
    // Roll back (no transactions): remove any batches we created for this PO, then reopen it for a
    // clean retry. CRITICAL: only revert the status if cleanup is CONFIRMED. If we can't verify the
    // batches were removed (e.g. a transient DB error), leave the PO 'received' (blocked) so a retry
    // hits the 409 guard and can never double the stock — surface it for manual reconciliation instead.
    let cleanedUp = false;
    try {
      const batchRepo = tenantRepo(InventoryBatch, ctx, { audit: false });
      const created = await batchRepo.find({ purchaseOrderId: po._id });
      for (const b of created) await batchRepo.softDeleteById(b._id);
      cleanedUp = true;
    } catch (cleanupErr) {
      console.error(`[pharmacyPurchaseOrderService] GRN rollback cleanup failed for PO ${po._id}; leaving it 'received' for manual reconciliation:`, cleanupErr?.message || cleanupErr);
    }
    if (cleanedUp) {
      await PurchaseOrder.updateOne({ _id: po._id, clinicId: ctx.clinicId }, { $set: { status: po.status, receivedAt: null } }).catch(() => {});
    }
    throw err;
  }
}

async function remove(ctx, id) {
  const po = await repo(ctx).findById(id);
  if (!po) throw new AppError(404, 'Purchase order not found');
  if (po.status === 'received') throw new AppError(400, 'A received purchase order cannot be deleted (its stock and expense are on the books)');
  const deleted = await repo(ctx).softDeleteById(id);
  return deleted;
}

module.exports = { list, get, create, update, setStatus, receive, remove, STATUSES: PurchaseOrder.STATUSES };
