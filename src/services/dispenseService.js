'use strict';

const { Dispense, DosageSchedule, Prescription, Medicine, InventoryBatch, Branch } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const branchService = require('./branchService');
const invoiceService = require('./invoiceService');
const alertService = require('./pharmacyAlertService');
const AppError = require('../utils/AppError');

/**
 * Prescription-linked dispensing (Ultra Premium, §6.4). Deducts stock FEFO (First-Expiry-First-Out),
 * never below zero, never from an expired batch, and safe under concurrent dispenses — all WITHOUT DB
 * transactions (none exist in this deployment). The guarantee comes from ATOMIC conditional decrements
 * (`updateOne` with quantityInStock:{$gte:take} + expiryDate:{$gte:now} in the filter): two dispensers
 * racing for the same batch can never both win, so stock can't go negative or be oversold. If any line
 * can't be fully filled (or the dispense record fails to save), every decrement made so far is rolled
 * back. Every dispense is against a valid clinic prescription (Rx enforcement, §5.3) and is audited
 * (the H1-register log, §12). Invoice + dosage schedules are created best-effort AFTER stock is committed.
 */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Allocate `needQty` of a medicine from its in-date batches at a branch, First-Expiry-First-Out.
 * Returns { allocations:[{batchId, qty}], shortfall }. Each decrement is atomic + conditional, so it
 * is concurrency-safe (a contended batch is re-read and retried a bounded number of times).
 */
async function allocateFEFO(ctx, medicineId, branchId, needQty) {
  const nowDate = () => new Date();
  const candidates = await tenantRepo(InventoryBatch, ctx, { audit: false }).find(
    { medicineId, branchId, expiryDate: { $gte: nowDate() }, quantityInStock: { $gt: 0 } },
    { sort: { expiryDate: 1 }, lean: true } // earliest expiry first (FEFO)
  );
  const allocations = [];
  let remaining = needQty;
  for (const b of candidates) {
    if (remaining <= 0) break;
    let batchQty = b.quantityInStock;
    for (let attempt = 0; attempt < 3 && remaining > 0 && batchQty > 0; attempt++) {
      const take = Math.min(remaining, batchQty);
      const res = await InventoryBatch.updateOne(
        { _id: b._id, clinicId: ctx.clinicId, deletedAt: null, expiryDate: { $gte: nowDate() }, quantityInStock: { $gte: take } },
        { $inc: { quantityInStock: -take } }
      );
      if (res.modifiedCount === 1) {
        allocations.push({ batchId: b._id, qty: take });
        remaining -= take;
        break;
      }
      // Contention (someone else decremented this batch between our read and write): re-read + retry.
      const fresh = await InventoryBatch.findOne({ _id: b._id, clinicId: ctx.clinicId, deletedAt: null }, { quantityInStock: 1 }).lean();
      batchQty = fresh ? fresh.quantityInStock : 0;
    }
  }
  return { allocations, shortfall: remaining };
}

/** Undo a set of atomic decrements (put stock back). Best-effort; never throws. */
async function rollback(ctx, allocations) {
  for (const a of allocations) {
    await InventoryBatch.updateOne({ _id: a.batchId, clinicId: ctx.clinicId }, { $inc: { quantityInStock: a.qty } }).catch(() => {});
  }
}

/**
 * Dispense selected medicines against a prescription.
 * @param items [{ medicineId, qty, unitPrice?, dosage?, timing?, durationDays?, instructions?, remindersEnabled? }]
 */
async function dispense(ctx, { prescriptionId, items, branchId, clientToken: rawToken } = {}) {
  // Rx enforcement (§5.3): a dispense MUST be against a valid clinic prescription.
  if (!prescriptionId) throw new AppError(400, 'A prescription is required to dispense');
  const rx = await tenantRepo(Prescription, ctx).findById(prescriptionId); // scoped, excludes soft-deleted
  if (!rx) throw new AppError(404, 'Prescription not found');
  if (!Array.isArray(items) || !items.length) throw new AppError(400, 'Select at least one medicine to dispense');

  // Idempotency: a retried/double-submitted dispense (same client token) returns the first result —
  // never a second stock deduction or duplicate invoice. (Same pattern as invoiceService.recordPayment.)
  const clientToken = typeof rawToken === 'string' && rawToken ? rawToken.slice(0, 100) : null;
  if (clientToken) {
    const prior = await tenantRepo(Dispense, ctx, { audit: false }).findOne({ clientToken }, { lean: true });
    if (prior) return prior;
  }

  // Branch: only the clinic's own (never trust a client branchId).
  let branch;
  if (branchId) {
    branch = await tenantRepo(Branch, ctx, { audit: false }).findById(branchId);
    if (!branch) throw new AppError(400, 'Invalid branch');
  } else {
    branch = await branchService.getOrCreatePrimaryBranch(ctx);
  }

  // Validate every line's medicine against the clinic's own catalog; snapshot name/price/gst.
  const medIds = [...new Set(items.map((i) => i && i.medicineId).filter(Boolean).map(String))];
  const meds = medIds.length ? await tenantRepo(Medicine, ctx, { audit: false }).find({ _id: { $in: medIds } }, { lean: true }) : [];
  const medById = Object.fromEntries(meds.map((m) => [String(m._id), m]));
  const prepared = items.map((it, idx) => {
    const med = medById[String(it.medicineId)];
    if (!med) throw new AppError(400, `Line ${idx + 1}: unknown medicine`);
    const qty = Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty < 1) throw new AppError(400, `Line ${idx + 1} (${med.name}): quantity must be at least 1`);
    const unitPrice = it.unitPrice === undefined || it.unitPrice === '' || it.unitPrice === null
      ? (med.sellingPrice != null ? med.sellingPrice : 0)
      : Math.max(0, Number(it.unitPrice) || 0);
    return {
      med,
      qty,
      unitPrice,
      gstRate: med.gstRate || 0,
      dosage: String(it.dosage || '').trim().slice(0, 60),
      timing: String(it.timing || '').trim().slice(0, 60),
      durationDays: it.durationDays != null && it.durationDays !== '' ? Math.max(0, Math.floor(Number(it.durationDays) || 0)) : null,
      instructions: String(it.instructions || '').trim().slice(0, 300),
      remindersEnabled: !!it.remindersEnabled,
    };
  });

  // ---- FEFO deduction (atomic, no-negative, no-expired, concurrency-safe) with cross-line rollback ----
  const allAllocations = [];
  const perLineAllocations = [];
  try {
    for (const line of prepared) {
      const { allocations, shortfall } = await allocateFEFO(ctx, line.med._id, branch._id, line.qty);
      allAllocations.push(...allocations);
      perLineAllocations.push(allocations);
      if (shortfall > 0) {
        throw new AppError(409, `Insufficient in-date stock for ${line.med.name}: short by ${shortfall} ${line.med.unit || 'unit'}(s)`);
      }
    }
  } catch (err) {
    await rollback(ctx, allAllocations);
    throw err;
  }

  // ---- Commit the dispense record (source of truth). Roll back stock if it fails. ----
  let dispenseDoc;
  try {
    const dispenseItems = prepared.map((line, i) => ({
      medicineId: line.med._id,
      medicineName: line.med.name,
      unit: line.med.unit || 'unit',
      qty: line.qty,
      unitPrice: line.unitPrice,
      gstRate: line.gstRate,
      allocations: perLineAllocations[i],
      dosage: line.dosage,
      timing: line.timing,
      durationDays: line.durationDays,
      instructions: line.instructions,
    }));
    const total = round2(dispenseItems.reduce((s, it) => s + it.qty * it.unitPrice, 0));
    dispenseDoc = await tenantRepo(Dispense, ctx).create({
      prescriptionId: rx._id,
      patientId: rx.patientId,
      patientName: rx.patientName,
      doctorId: rx.doctorId || null,
      items: dispenseItems,
      total,
      branchId: branch._id,
      clientToken,
      dispensedBy: ctx.actorId || null,
      dispensedAt: new Date(),
      createdBy: ctx.actorId || null,
    });
  } catch (err) {
    await rollback(ctx, allAllocations);
    throw err;
  }

  // ---- Best-effort follow-ups: NEVER reverse committed stock if these fail (the meds are gone). ----
  // Dosage schedules (§6.5).
  try {
    const dsRepo = tenantRepo(DosageSchedule, ctx);
    for (const line of prepared) {
      if (!line.dosage && !line.durationDays && !line.instructions) continue;
      const startDate = new Date();
      const endDate = line.durationDays ? new Date(startDate.getTime() + line.durationDays * DAY_MS) : null;
      await dsRepo.create({
        patientId: rx.patientId,
        medicineId: line.med._id,
        medicineName: line.med.name,
        sourceType: 'dispense',
        sourceId: dispenseDoc._id,
        dosage: line.dosage,
        timing: line.timing,
        durationDays: line.durationDays,
        instructions: line.instructions,
        startDate,
        endDate,
        remindersEnabled: line.remindersEnabled,
        createdBy: ctx.actorId || null,
      });
    }
  } catch (err) {
    console.error('[dispenseService] dosage schedule creation failed:', err?.message || err);
  }

  // GST invoice via the EXISTING billing service (additive reuse). Blended effective rate so the
  // single-rate invoice's GST equals the sum of per-line GST. Skipped when nothing is priced.
  let createdInvoiceId = null;
  try {
    const invoiceItems = prepared
      .filter((l) => l.unitPrice > 0)
      .map((l) => ({ description: `${l.med.name}${l.med.strength ? ' ' + l.med.strength : ''} × ${l.qty}`, amount: l.unitPrice, quantity: l.qty }));
    if (invoiceItems.length) {
      const subtotal = invoiceItems.reduce((s, it) => s + it.amount * it.quantity, 0);
      const gst = prepared.reduce((s, l) => s + l.unitPrice * l.qty * (l.gstRate / 100), 0);
      const blendedRate = subtotal > 0 ? round2((gst / subtotal) * 100) : 0;
      const invoice = await invoiceService.create(ctx, { patientId: rx.patientId, items: invoiceItems, gstRate: blendedRate });
      createdInvoiceId = invoice._id;
      await tenantRepo(Dispense, ctx).updateById(dispenseDoc._id, { invoiceId: invoice._id });
      dispenseDoc.invoiceId = invoice._id;
    }
  } catch (err) {
    // Best-effort: the dispense stands. If an invoice WAS created but the link write failed, log its id
    // so the orphan can be reconciled to this dispense rather than being silently lost.
    const orphan = createdInvoiceId ? ` (invoice ${createdInvoiceId} created but NOT linked — reconcile to dispense ${dispenseDoc._id})` : '';
    console.error(`[dispenseService] invoice step failed (dispense stands)${orphan}:`, err?.message || err);
  }

  // Stock-health alerts (stock just dropped).
  for (const line of prepared) alertService.checkMedicine(ctx, String(line.med._id)).catch(() => {});

  return tenantRepo(Dispense, ctx).findById(dispenseDoc._id, { lean: true });
}

async function list(ctx, { patientId, prescriptionId } = {}) {
  const filter = {};
  if (typeof patientId === 'string') filter.patientId = patientId;
  if (typeof prescriptionId === 'string') filter.prescriptionId = prescriptionId;
  const items = await tenantRepo(Dispense, ctx).find(filter, { sort: { createdAt: -1 }, limit: 500, lean: true });
  return { items };
}

async function getById(ctx, id) {
  const d = await tenantRepo(Dispense, ctx).findById(id, { lean: true });
  if (!d) throw new AppError(404, 'Dispense not found');
  return d;
}

module.exports = { dispense, list, getById, allocateFEFO, rollbackAllocations: rollback };
