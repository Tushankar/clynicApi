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
async function recordPayment(ctx, id, { amount, method, reference }) {
  const inv = await getById(ctx, id);
  // Idempotent for gateway payments: if this online reference (Razorpay paymentId) is
  // already recorded, do nothing — a webhook retry / callback race must never double-credit
  // (payment rule 2). Desk payments (cash/upi/card) carry no reference and are unaffected.
  if (reference && inv.payments.some((p) => p.reference === reference)) return inv;
  const amt = round2(amount);
  if (!(amt > 0)) throw new AppError(400, 'Payment amount must be positive');
  if (!['cash', 'upi', 'card', 'online'].includes(method)) throw new AppError(400, 'Invalid payment method');

  const payments = [...inv.payments, { amount: amt, method, reference, paidAt: new Date(), byStaffId: ctx.actorId || null }];
  const amountPaid = round2(inv.amountPaid + amt);
  const next = { payments, amountPaid };
  next.status = deriveStatus({ ...inv.toObject(), amountPaid });

  const updated = await repo(ctx).updateById(id, next);
  notificationService.emit(ctx, { type: 'payment_received', message: `Payment of ₹${amt} received for ${inv.patientName || 'patient'} (${inv.invoiceNumber})`, link: '/billing' }).catch(() => {});
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
  notificationService.emit(ctx, { type: 'payment_received', message: `Refund of ₹${amt} issued (${inv.invoiceNumber})`, link: '/billing' }).catch(() => {});
  return updated;
}

async function softDelete(ctx, id) {
  const deleted = await repo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Invoice not found');
  return deleted;
}

module.exports = { create, list, getById, recordPayment, refund, softDelete, computeTotals, deriveStatus };
