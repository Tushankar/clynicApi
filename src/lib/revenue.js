'use strict';

const mongoose = require('mongoose');

/**
 * ============================================================================
 *  Revenue — ONE definition, used by every surface that reports money.
 * ============================================================================
 *
 * The product previously computed "revenue" four different ways, and two of them sat on the same
 * Analytics screen:
 *
 *   1. analyticsService revenue chart : invoices matched on `createdAt`, summing `amountPaid`
 *   2. analyticsService P&L card      : payments unwound and bucketed by `payments.paidAt`
 *   3. invoiceService dayRegister     : payments unwound by `paidAt` (the cash register)
 *   4. AppointmentsPage (browser)     : summed client-side from the appointment list
 *
 * (1) is neither cash-basis nor accrual — it credits an invoice's ENTIRE lifetime payments to the
 * month the invoice was raised, so an invoice billed on 31 Aug and paid on 15 Sep counted fully in
 * August. And NONE of the four subtracted refunds. Against real data that overstated revenue by
 * 26% (₹40,498 reported against ₹10,530 refunded).
 *
 * The definition below is CASH BASIS, net of refunds:
 *
 *     revenue(range) = Σ payments where paidAt ∈ range  −  Σ refunds where at ∈ range
 *
 * Cash basis is the right default for a clinic because it is what the day-end register reconciles
 * against — the money actually in the drawer and the gateway. If accrual ("billed") is ever wanted,
 * add it as a separate, separately-LABELLED figure; never silently mix the two.
 *
 * Soft-deleted (voided) invoices are excluded everywhere, so voiding a mis-issued invoice removes
 * it from revenue as well as from dues.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Clinic + branch scope shared by every pipeline here (rule 1 + rule 8). */
function scope(ctx, branchId) {
  const match = { clinicId: ctx.clinicId, deletedAt: null };
  if (branchId && mongoose.isValidObjectId(branchId)) {
    match.branchId = new mongoose.Types.ObjectId(branchId);
  }
  return match;
}

/**
 * Net revenue collected in a range, optionally bucketed.
 *
 * @param {object} ctx        tenant context ({ clinicId })
 * @param {object} opts
 * @param {Date}   opts.start
 * @param {Date}   opts.end
 * @param {string} [opts.groupBy]  '%Y-%m-%d' | '%Y-%m' — omit for a single total
 * @param {string} [opts.timezone] IANA zone for bucket boundaries
 * @param {string} [opts.branchId]
 * @returns {Promise<{ total: number, collected: number, refunded: number, byBucket: Array<{key,revenue,collected,refunded}> }>}
 */
async function collectedInRange(Invoice, ctx, { start, end, groupBy = null, timezone = 'Asia/Kolkata', branchId = null } = {}) {
  const base = scope(ctx, branchId);
  const bucket = (dateField) =>
    groupBy ? { $dateToString: { format: groupBy, date: dateField, timezone } } : null;

  const [payAgg, refAgg] = await Promise.all([
    Invoice.aggregate([
      { $match: base },
      { $unwind: '$payments' },
      { $match: { 'payments.paidAt': { $gte: start, $lte: end } } },
      { $group: { _id: bucket('$payments.paidAt'), amount: { $sum: '$payments.amount' } } },
    ]),
    Invoice.aggregate([
      { $match: base },
      { $unwind: '$refunds' },
      { $match: { 'refunds.at': { $gte: start, $lte: end } } },
      { $group: { _id: bucket('$refunds.at'), amount: { $sum: '$refunds.amount' } } },
    ]),
  ]);

  const collected = round2(payAgg.reduce((s, r) => s + (r.amount || 0), 0));
  const refunded = round2(refAgg.reduce((s, r) => s + (r.amount || 0), 0));

  const byKey = new Map();
  for (const r of payAgg) byKey.set(r._id, { key: r._id, collected: round2(r.amount), refunded: 0 });
  for (const r of refAgg) {
    const cur = byKey.get(r._id) || { key: r._id, collected: 0, refunded: 0 };
    cur.refunded = round2(r.amount);
    byKey.set(r._id, cur);
  }
  const byBucket = [...byKey.values()]
    .map((b) => ({ ...b, revenue: round2(b.collected - b.refunded) }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));

  return { total: round2(collected - refunded), collected, refunded, byBucket };
}

/** The statuses that can carry an outstanding balance — the canonical dues filter. */
const OUTSTANDING_STATUSES = Object.freeze(['unpaid', 'partially_paid']);

/**
 * Outstanding balance on ONE invoice — the single definition.
 *
 * This was previously derived in eleven places under three conventions: some clamped at zero and
 * some did not, and `exportService` applied no status filter at all, so the CSV a clinic sent its
 * accountant disagreed with every screen. Clamped at zero because an overpaid invoice owes nothing
 * (a credit is a refund, not a negative due).
 */
function balanceDue(invoice) {
  if (!invoice) return 0;
  // A cancelled or refunded invoice owes nothing, whatever the arithmetic says. Screens already
  // filtered these out by status while the CSV export did not, so the figure a clinic sent its
  // accountant disagreed with the figure on its own Billing page.
  if (!OUTSTANDING_STATUSES.includes(invoice.status)) return 0;
  // Clamped at zero: an overpayment is a credit to refund, not a negative amount due.
  return Math.max(0, round2((invoice.total || 0) - (invoice.amountPaid || 0)));
}


module.exports = { collectedInRange, balanceDue, OUTSTANDING_STATUSES, round2 };
