'use strict';

const { Invoice, Patient } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { nextSequence } = require('../lib/sequence');
const branchService = require('./branchService');
const notificationService = require('./notificationService');
const { dayRange } = require('../lib/datetime');
const AppError = require('../utils/AppError');

function repo(ctx) {
  return tenantRepo(Invoice, ctx); // audited (financial — hard rule 7)
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Clamp GST rate to a sane non-negative bound so totals can never go negative.
function safeGstRate(gstRate) {
  const r = Number(gstRate);
  return Number.isFinite(r) ? Math.min(100, Math.max(0, r)) : 0;
}

function computeTotals(items, gstRate) {
  const subtotal = round2((items || []).reduce((s, it) => s + (Number(it.amount) || 0) * (Number(it.quantity) || 1), 0));
  const gstAmount = round2((subtotal * safeGstRate(gstRate)) / 100);
  return { subtotal, gstAmount, total: round2(subtotal + gstAmount) };
}

function deriveStatus(inv) {
  if (inv.amountRefunded > 0 && inv.amountRefunded >= inv.amountPaid && inv.amountPaid > 0) return 'refunded';
  if (inv.amountPaid >= inv.total && inv.total > 0) return 'paid';
  if (inv.amountPaid > 0) return 'partially_paid';
  return 'unpaid';
}

async function create(ctx, data) {
  const { patientId, appointmentId, items = [], gstRate = 0 } = data;
  if (!patientId) throw new AppError(400, 'patientId is required');
  const cleanItems = items.filter((it) => it && it.description && Number(it.amount) >= 0);
  if (cleanItems.length === 0) throw new AppError(400, 'At least one line item is required');

  const patient = await tenantRepo(Patient, ctx).findById(patientId);
  if (!patient) throw new AppError(404, 'Patient not found');
  const branch = await branchService.getOrCreatePrimaryBranch(ctx);
  const seq = await nextSequence(ctx.clinicId, 'invoice');
  const rate = safeGstRate(gstRate);
  const totals = computeTotals(cleanItems, rate);

  return repo(ctx).create({
    invoiceNumber: `INV-${String(seq).padStart(5, '0')}`,
    patientId,
    appointmentId: appointmentId || undefined,
    patientName: patient.name,
    items: cleanItems,
    gstRate: rate,
    ...totals,
    status: 'unpaid',
    branchId: branch._id,
  });
}

function list(ctx, { patientId, appointmentId, status, date } = {}) {
  const filter = {};
  if (patientId) filter.patientId = patientId;
  if (appointmentId) filter.appointmentId = appointmentId;
  if (status) filter.status = status;
  if (date) {
    const { start, end } = dayRange(date);
    filter.createdAt = { $gte: start, $lte: end };
  }
  return repo(ctx).find(filter, { sort: { createdAt: -1 }, lean: true });
}

async function getById(ctx, id) {
  const inv = await repo(ctx).findById(id);
  if (!inv) throw new AppError(404, 'Invoice not found');
  return inv;
}

/**
 * Record a payment against an invoice (cash/UPI/card at the desk, or a verified
 * online payment applied by paymentService). Recomputes status; audited.
 */
async function recordPayment(ctx, id, { amount, method, reference, idempotencyKey }) {
  const inv = await getById(ctx, id);
  // Idempotent for gateway payments: if this online reference (Razorpay paymentId) is
  // already recorded, do nothing — a webhook retry / callback race must never double-credit
  // (payment rule 2).
  if (reference && inv.payments.some((p) => p.reference === reference)) return inv;
  // Idempotent for DESK payments: a client-generated key makes a double-tapped or retried-on-
  // flaky-wifi "Record ₹X cash" safe — the second identical request is a no-op, not a double credit.
  if (idempotencyKey && inv.payments.some((p) => p.idempotencyKey === idempotencyKey)) return inv;
  const amt = round2(amount);
  if (!(amt > 0)) throw new AppError(400, 'Payment amount must be positive');
  if (!['cash', 'upi', 'card', 'online'].includes(method)) throw new AppError(400, 'Invalid payment method');

  // Never let an invoice be overpaid past its total (corrupts the daily cash register).
  const outstanding = round2(inv.total - inv.amountPaid);
  if (outstanding <= 0) {
    // Already settled. A duplicate gateway capture landing here is a safe no-op (prevents the
    // second-order double-credit); a desk attempt is a staff error worth surfacing.
    if (reference) return inv;
    throw new AppError(400, 'This invoice is already fully paid');
  }
  if (!reference && amt > outstanding + 0.01) {
    throw new AppError(400, `Payment of ₹${amt} exceeds the outstanding balance of ₹${outstanding}. Enter ₹${outstanding} or less.`);
  }
  // Gateway amounts already equal the outstanding balance; clamp defensively so a stray concurrent
  // capture can never push amountPaid past total.
  const applied = reference ? Math.min(amt, outstanding) : amt;

  const entry = { amount: applied, method, reference, paidAt: new Date(), byStaffId: ctx.actorId || null };
  if (idempotencyKey) entry.idempotencyKey = idempotencyKey;
  const payments = [...inv.payments, entry];
  const amountPaid = round2(inv.amountPaid + applied);
  const next = { payments, amountPaid };
  next.status = deriveStatus({ ...inv.toObject(), amountPaid });

  const updated = await repo(ctx).updateById(id, next);
  notificationService.emit(ctx, { type: 'payment_received', message: `Payment of ₹${applied} received for ${inv.patientName || 'patient'} (${inv.invoiceNumber})`, link: '/billing' }).catch(() => {});
  return updated;
}

async function refund(ctx, id, { amount, reason }) {
  const inv = await getById(ctx, id);
  const amt = round2(amount);
  if (!(amt > 0)) throw new AppError(400, 'Refund amount must be positive');
  if (amt > round2(inv.amountPaid - inv.amountRefunded)) throw new AppError(400, 'Refund exceeds the paid amount');

  const refunds = [...inv.refunds, { amount: amt, reason, at: new Date(), byStaffId: ctx.actorId || null }];
  const amountRefunded = round2(inv.amountRefunded + amt);
  const next = { refunds, amountRefunded };
  next.status = deriveStatus({ ...inv.toObject(), amountRefunded });

  const updated = await repo(ctx).updateById(id, next);
  notificationService.emit(ctx, { type: 'payment_refunded', message: `Refund of ₹${amt} issued (${inv.invoiceNumber})`, link: '/billing' }).catch(() => {});
  return updated;
}

async function softDelete(ctx, id) {
  const deleted = await repo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Invoice not found');
  return deleted;
}

/** Owner-only recovery of a mis-deleted invoice (undo a soft delete). */
async function restore(ctx, id) {
  const restored = await repo(ctx).restoreById(id);
  if (!restored) throw new AppError(404, 'No deleted invoice found to restore');
  return restored;
}

/** Recently-deleted invoices (owner "recently deleted" view). */
function listDeleted(ctx, { limit = 100 } = {}) {
  return repo(ctx).listDeleted({}, { limit });
}

/**
 * Daily cash register (§5.23, CASH_REGISTER): every payment entry recorded on `date`
 * regardless of when the invoice was raised — cash/UPI/card/online split, the day's
 * refunds, and the clinic's total outstanding dues. Aggregations $match clinicId
 * explicitly (they bypass the tenant repo — that match IS the isolation guarantee).
 */
async function dayRegister(ctx, { date, branchId } = {}) {
  const { Invoice } = require('../models');
  const mongoose = require('mongoose');
  const { start, end } = dayRange(date || new Date());
  const baseMatch = { clinicId: ctx.clinicId, deletedAt: null };
  if (branchId && mongoose.isValidObjectId(branchId)) baseMatch.branchId = new mongoose.Types.ObjectId(branchId);

  const [paymentsAgg, refundsAgg, duesAgg] = await Promise.all([
    Invoice.aggregate([
      { $match: baseMatch },
      { $unwind: '$payments' },
      { $match: { 'payments.paidAt': { $gte: start, $lte: end } } },
      {
        $project: {
          invoiceNumber: 1,
          patientName: 1,
          amount: '$payments.amount',
          method: '$payments.method',
          reference: '$payments.reference',
          paidAt: '$payments.paidAt',
          byStaffId: '$payments.byStaffId',
        },
      },
      { $sort: { paidAt: -1 } },
      { $limit: 500 },
    ]),
    Invoice.aggregate([
      { $match: baseMatch },
      { $unwind: '$refunds' },
      { $match: { 'refunds.at': { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$refunds.amount' }, count: { $sum: 1 } } },
    ]),
    Invoice.aggregate([
      { $match: { ...baseMatch, status: { $in: ['unpaid', 'partially_paid'] } } },
      { $group: { _id: null, amount: { $sum: { $subtract: ['$total', '$amountPaid'] } }, count: { $sum: 1 } } },
    ]),
  ]);

  const byMethod = { cash: 0, upi: 0, card: 0, online: 0 };
  let total = 0;
  for (const p of paymentsAgg) {
    byMethod[p.method] = round2((byMethod[p.method] || 0) + p.amount);
    total = round2(total + p.amount);
  }

  return {
    date: new Date(start).toISOString(),
    totals: { ...byMethod, total, count: paymentsAgg.length },
    refunds: { total: refundsAgg[0]?.total || 0, count: refundsAgg[0]?.count || 0 },
    dues: { amount: round2(duesAgg[0]?.amount || 0), count: duesAgg[0]?.count || 0 },
    entries: paymentsAgg.map((p) => ({
      invoiceId: String(p._id),
      invoiceNumber: p.invoiceNumber,
      patientName: p.patientName || '',
      amount: p.amount,
      method: p.method,
      reference: p.reference || '',
      paidAt: p.paidAt,
    })),
  };
}

module.exports = { create, list, getById, recordPayment, refund, softDelete, restore, listDeleted, dayRegister, computeTotals, deriveStatus };
