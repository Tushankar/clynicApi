'use strict';

const { Medicine, InventoryBatch } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const notificationService = require('./notificationService');

/**
 * Pharmacy stock-health alerts (Ultra Premium, §6.3). Recomputes a medicine's live
 * availability from its NON-EXPIRED batches and pushes low-stock / near-expiry alerts to
 * pharmacy staff via the existing notification center (bell). Fire-and-forget by design:
 * checkMedicine NEVER throws into a caller — an alert failure must never break a stock write.
 *
 * Alerts are emitted inline on inventory writes AND by a scheduled cross-tenant sweep
 * (sweepExpiring) so a batch quietly ageing into its expiry window with no stock activity is
 * still caught. Both paths pass a per-medicine dedupeKey so the bell never stacks duplicates
 * (a fresh alert reappears only after staff clear the previous one — see notificationService.emit).
 */
const NEAR_EXPIRY_DAYS = 60; // "expiring soon" window (product decision)
const DAY_MS = 24 * 60 * 60 * 1000;

// Reads only — tenantRepo never audits find(); {audit:false} documents "system read".
function batchRepo(ctx) {
  return tenantRepo(InventoryBatch, ctx, { audit: false });
}
function medicineRepo(ctx) {
  return tenantRepo(Medicine, ctx, { audit: false });
}

/**
 * Live stock summary for one medicine (compute-on-read): available = Σ quantityInStock of
 * non-expired batches; expired stock is excluded from availability (never sellable, §5).
 */
async function summarize(ctx, medicineId) {
  const batches = await batchRepo(ctx).find({ medicineId }, { lean: true }); // soft-deleted excluded
  const now = Date.now();
  const soonCutoff = now + NEAR_EXPIRY_DAYS * DAY_MS;
  let available = 0;
  let expiringSoonQty = 0;
  let expiredQty = 0;
  let nearestExpiry = null;
  for (const b of batches) {
    const qty = b.quantityInStock || 0;
    const exp = b.expiryDate ? new Date(b.expiryDate).getTime() : null;
    if (exp !== null && exp < now) {
      expiredQty += qty;
    } else {
      available += qty;
      if (exp !== null && exp <= soonCutoff) expiringSoonQty += qty;
    }
    if (exp !== null && (nearestExpiry === null || exp < nearestExpiry)) nearestExpiry = exp;
  }
  return {
    available,
    expiringSoonQty,
    expiredQty,
    batchCount: batches.length,
    nearestExpiry: nearestExpiry ? new Date(nearestExpiry) : null,
  };
}

/**
 * Recompute a medicine's stock health and emit alerts if warranted. Safe to call after any
 * batch/medicine write. Swallows all errors (fire-and-forget).
 */
async function checkMedicine(ctx, medicineId) {
  try {
    const med = await medicineRepo(ctx).findById(medicineId);
    if (!med) return;
    const s = await summarize(ctx, medicineId);
    const link = '/dashboard/pharmacy/inventory';
    const unit = med.unit || 'unit';
    // Low stock: only when the owner has SET a reorder level (avoids noise on never-stocked items).
    if (med.reorderLevel > 0 && s.available <= med.reorderLevel) {
      notificationService
        .emit(ctx, {
          type: 'low_stock',
          message: `Low stock: ${med.name} — ${s.available} ${unit}(s) left (reorder at ${med.reorderLevel}).`,
          link,
          dedupeKey: `low_stock:${medicineId}`,
        })
        .catch(() => {});
    }
    // Near expiry: any live stock within the window.
    if (s.expiringSoonQty > 0) {
      notificationService
        .emit(ctx, {
          type: 'stock_expiry',
          message: `Expiring soon: ${med.name} — ${s.expiringSoonQty} ${unit}(s) within ${NEAR_EXPIRY_DAYS} days.`,
          link,
          dedupeKey: `stock_expiry:${medicineId}`,
        })
        .catch(() => {});
    }
  } catch (err) {
    console.error('[pharmacyAlertService] checkMedicine failed:', err?.message || err);
  }
}

/**
 * Scheduled cross-tenant expiry sweep (fills the gap the inline checks leave). Inline alerts only
 * fire on a stock WRITE, but expiry advances with the clock — a batch ageing into the window while
 * untouched would never alert. One indexed query finds every live batch expiring within the window
 * across all clinics; each affected medicine is re-checked (emitting de-duplicated alerts). Runs
 * from the campaign tick (jobs/campaignRunner). Never throws; returns a small summary for logs/tests.
 */
async function sweepExpiring(now = new Date()) {
  const soonCutoff = new Date(now.getTime() + NEAR_EXPIRY_DAYS * DAY_MS);
  let checked = 0;
  try {
    // System job: query the model directly (cross-tenant, no per-request ctx), bounded by the
    // { clinicId, expiryDate } index. Exclude already-expired (not "expiring soon") and empty batches.
    const batches = await InventoryBatch.find(
      { deletedAt: null, quantityInStock: { $gt: 0 }, expiryDate: { $gte: now, $lte: soonCutoff } },
      { clinicId: 1, medicineId: 1 }
    ).lean();
    const seen = new Set(); // one check per (clinic, medicine)
    for (const b of batches) {
      const key = `${b.clinicId}:${b.medicineId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // eslint-disable-next-line no-await-in-loop
      await checkMedicine({ clinicId: b.clinicId, actorId: 'system', actorRole: 'system' }, b.medicineId);
      checked += 1;
    }
  } catch (err) {
    console.error('[pharmacyAlertService] sweepExpiring failed:', err?.message || err);
  }
  return { checked };
}

module.exports = { checkMedicine, summarize, sweepExpiring, NEAR_EXPIRY_DAYS };
