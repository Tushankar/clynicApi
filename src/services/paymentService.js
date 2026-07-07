'use strict';

const { Payment, WebhookEvent, AuditLog } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const gateway = require('../lib/payments');
const invoiceService = require('./invoiceService');
const config = require('../config/env');
const AppError = require('../utils/AppError');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function repo(ctx) {
  return tenantRepo(Payment, ctx); // audited (money event)
}

/** Create a Razorpay order for an invoice's outstanding balance (server-side amount). */
async function createInvoiceOrder(ctx, invoiceId) {
  const inv = await invoiceService.getById(ctx, invoiceId);
  const outstanding = round2(inv.total - inv.amountPaid);
  if (!(outstanding > 0)) throw new AppError(400, 'Invoice has no outstanding balance');

  // Reuse an existing OPEN order for this invoice instead of minting a new one. Otherwise a patient
  // who taps Pay twice (or reloads after a dropped response) creates a second full-value order, and
  // two captures would double-charge. Only reuse when the amount still matches the live outstanding;
  // a stale-amount open order (a partial payment landed since) is retired so it can't be paid later.
  const open = await Payment.findOne({ clinicId: ctx.clinicId, kind: 'invoice', invoiceId: inv._id, status: { $in: ['created', 'processing'] } }).sort({ createdAt: -1 });
  if (open) {
    if (round2(open.amount) === outstanding) {
      return { orderId: open.orderId, amount: open.amount, currency: open.currency, keyId: config.payments.keyId, driver: gateway.driver, paymentRecordId: String(open._id), reused: true };
    }
    await Payment.updateOne({ clinicId: ctx.clinicId, _id: open._id, status: 'created' }, { $set: { status: 'expired' } });
  }

  const order = await gateway.createOrder({ amount: outstanding, currency: config.payments.currency, receipt: inv.invoiceNumber });
  const payment = await repo(ctx).create({
    kind: 'invoice',
    invoiceId: inv._id,
    patientId: inv.patientId,
    branchId: inv.branchId,
    provider: gateway.driver,
    orderId: order.id,
    amount: outstanding,
    currency: order.currency,
    status: 'created',
  });
  return { orderId: order.id, amount: outstanding, currency: order.currency, keyId: order.keyId, driver: gateway.driver, paymentRecordId: String(payment._id) };
}

async function auditCapture(ctx, payment) {
  await AuditLog.create({
    clinicId: ctx.clinicId,
    actorId: ctx.actorId || null,
    actorRole: ctx.actorRole || null,
    action: 'update',
    entityType: 'Payment',
    entityId: payment._id,
    after: { status: 'paid', paymentId: payment.paymentId, amount: payment.amount, kind: payment.kind },
  });
}

/** Apply the side effect of a captured payment (idempotency already guaranteed by the caller). */
async function applyCapture(ctx, payment) {
  if (payment.kind === 'invoice' && payment.invoiceId) {
    await invoiceService.recordPayment(ctx, payment.invoiceId, { amount: payment.amount, method: 'online', reference: payment.paymentId });
  } else if (payment.kind === 'prepayment' && payment.appointmentId) {
    // Lazy require avoids a cycle; marks the appointment prepaid + confirmed (step 5).
    await require('./prepaymentService').markPrepaid(ctx, payment.appointmentId, payment.paymentId);
  }
}

/**
 * Claim an order and apply its effect exactly once (payment rule 2).
 *
 * The claim moves the order created → processing (capturing the paymentId), THEN runs the
 * side effect, THEN marks it paid. Marking paid is the commit point — it happens only after
 * the credit succeeds, so an apply that throws leaves the row 'processing' (no paid, no
 * webhook-dedup row) and the provider's retry re-claims and re-applies. A 'paid' row, or a
 * missing order, is a no-op. The side effects are themselves idempotent (recordPayment
 * de-dupes by gateway reference; markPrepaid by the prepaid flag), so even a concurrent
 * double-delivery that both reach 'processing' credits at most once.
 */
async function claimAndApply(ctx, { orderId, paymentId, method = 'online' }) {
  const claimed = await Payment.findOneAndUpdate(
    { clinicId: ctx.clinicId, orderId, status: { $in: ['created', 'processing'] } },
    { $set: { paymentId, status: 'processing', signatureVerified: true, method } },
    { new: true }
  );
  if (!claimed) return { applied: false, reason: 'already_processed' };
  // Audit the claim transition too, so the money trail covers created→processing→paid (rule 7).
  // The atomic findOneAndUpdate above is intentional (idempotency/concurrency) and stays inline;
  // it is always clinic-scoped, so tenant isolation holds without the tenant repo.
  await AuditLog.create({ clinicId: ctx.clinicId, actorId: ctx.actorId || null, actorRole: ctx.actorRole || null, action: 'update', entityType: 'Payment', entityId: claimed._id, after: { status: 'processing', paymentId } });
  await applyCapture(ctx, claimed); // idempotent — see above
  await Payment.updateOne({ clinicId: ctx.clinicId, _id: claimed._id }, { $set: { status: 'paid' } });
  await auditCapture(ctx, claimed);
  return { applied: true, paymentId, status: 'paid' };
}

/**
 * Refund the ONLINE-paid portion of an invoice back through the gateway (Razorpay refund API),
 * allocated across this invoice's captured payments (newest first, each up to its un-refunded
 * balance). Cash/desk payments have no gateway leg — staff return the cash — so this refunds at
 * most the online-captured total. Records each gateway refund on the Payment (refunds[]/
 * amountRefunded; status → 'refunded' once fully refunded) and audits it. THROWS if the gateway
 * rejects, so the caller must not update the books on a failed refund (no phantom refunds).
 * Returns { onlineRefunded, refunds }.
 */
async function refundForInvoice(ctx, invoiceId, amount, reason) {
  const amt = round2(amount);
  const payments = await Payment.find({
    clinicId: ctx.clinicId,
    kind: 'invoice',
    invoiceId,
    status: { $in: ['paid', 'refunded'] },
    paymentId: { $type: 'string' },
  }).sort({ createdAt: -1 });

  let remaining = amt;
  const refunds = [];
  for (const p of payments) {
    if (remaining <= 0) break;
    const refundable = round2((p.amount || 0) - (p.amountRefunded || 0));
    if (refundable <= 0) continue;
    const portion = round2(Math.min(remaining, refundable));
    // eslint-disable-next-line no-await-in-loop
    const res = await gateway.refund({ paymentId: p.paymentId, amount: portion, notes: { reason: reason || 'refund', invoiceId: String(invoiceId) } });
    p.refunds.push({ refundId: res.id, amount: portion, reason, status: res.status || 'processed' });
    p.amountRefunded = round2((p.amountRefunded || 0) + portion);
    if (p.amountRefunded >= round2(p.amount)) p.status = 'refunded';
    // eslint-disable-next-line no-await-in-loop
    await p.save();
    // eslint-disable-next-line no-await-in-loop
    await AuditLog.create({ clinicId: ctx.clinicId, actorId: ctx.actorId || null, actorRole: ctx.actorRole || null, action: 'update', entityType: 'Payment', entityId: p._id, after: { refundId: res.id, amount: portion, status: p.status } });
    refunds.push({ paymentId: p.paymentId, refundId: res.id, amount: portion });
    remaining = round2(remaining - portion);
  }
  return { onlineRefunded: round2(amt - remaining), refunds };
}

/** Reconcile a refund.* webhook against the Payment (records/updates the refund entry; alerts on failure). */
async function reconcileRefundStatus(ctx, payment, { refundId, amount, status }) {
  const existing = payment.refunds.find((r) => r.refundId === refundId);
  if (existing) {
    existing.status = status;
  } else {
    payment.refunds.push({ refundId, amount, status });
    if (status === 'processed') payment.amountRefunded = round2((payment.amountRefunded || 0) + amount);
  }
  if (round2(payment.amountRefunded || 0) >= round2(payment.amount)) payment.status = 'refunded';
  await payment.save();
  if (status === 'failed') {
    require('./notificationService')
      .emit(ctx, { type: 'other', message: `A refund (${refundId}) FAILED at the gateway — the patient may not have received their money. Please check billing.`, link: '/billing' })
      .catch(() => {});
  }
}

/**
 * Verify a checkout callback. The signature is checked SERVER-SIDE; a forged or
 * client-only "paid" claim is rejected and nothing is credited (payment rule 1).
 */
async function verifyPayment(ctx, { orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) throw new AppError(400, 'orderId, paymentId and signature are required');
  if (!gateway.verifyPaymentSignature({ orderId, paymentId, signature })) {
    throw new AppError(400, 'Payment signature verification failed');
  }
  return claimAndApply(ctx, { orderId, paymentId, method: 'online' });
}

/**
 * Handle a provider webhook. Verifies the signature over the RAW body, de-dupes by
 * event id (so retries never double-apply), then applies the captured payment via the
 * same atomic claim. Subscription events are delegated to subscriptionService (step 7).
 */
async function handleWebhook(rawBody, signature, eventIdHeader) {
  if (!gateway.verifyWebhookSignature(rawBody, signature)) throw new AppError(400, 'Invalid webhook signature');

  let event;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    throw new AppError(400, 'Invalid webhook payload');
  }
  const eventId = event.id || eventIdHeader;
  if (!eventId) throw new AppError(400, 'Missing event id');

  // De-dup: skip if already processed. We record the event id AFTER the side effect
  // succeeds (not before), so a transient apply failure leaves no ledger row and the
  // provider's retry re-applies. Both apply paths are idempotent, so a rare double
  // delivery before the row is written is a safe no-op (payment rule 2).
  const provider = gateway.driver;
  if (await WebhookEvent.findOne({ provider, eventId })) return { duplicate: true };

  const type = event.event || '';
  if (type.startsWith('payment.')) {
    const entity = event.payload?.payment?.entity || {};
    const orderId = entity.order_id;
    const paymentId = entity.id;
    if (orderId && paymentId) {
      const payment = await Payment.findOne({ orderId });
      if (payment) {
        const ctx = { clinicId: payment.clinicId, actorId: 'system:webhook', actorRole: null };
        await claimAndApply(ctx, { orderId, paymentId, method: entity.method || 'online' });
      }
    }
  } else if (type.startsWith('refund.')) {
    // refund.processed / refund.failed — reconcile the async outcome of a gateway refund.
    const entity = event.payload?.refund?.entity || {};
    const paymentId = entity.payment_id;
    if (paymentId) {
      const payment = await Payment.findOne({ paymentId });
      if (payment) {
        const ctx = { clinicId: payment.clinicId, actorId: 'system:webhook', actorRole: null };
        await reconcileRefundStatus(ctx, payment, { refundId: entity.id, amount: round2((entity.amount || 0) / 100), status: entity.status || 'processed' });
      }
    }
  } else if (type.startsWith('subscription.')) {
    await require('./subscriptionService').handleSubscriptionWebhook(event);
  }

  // Side effect succeeded — now durably record the event so retries are no-ops.
  await WebhookEvent.create({ provider, eventId, type: event.event }).catch((err) => {
    if (err.code !== 11000) throw err;
  });
  return { processed: true };
}

// Reconciliation windows.
const STUCK_PROCESSING_MINUTES = 15; // claimed but never committed to 'paid' (dropped verify/webhook)
const ABANDONED_CREATED_MINUTES = 30; // order created, checkout never completed

/**
 * Reconcile stuck payments (run on a timer). Two jobs:
 *   1) A 'processing' row that carries a paymentId but was never committed to 'paid' means the
 *      /verify round-trip or webhook dropped AFTER the money was captured — the classic
 *      captured-but-uncredited case. Re-running the idempotent claim finishes the credit (or is a
 *      safe no-op if it already landed). If it still can't be applied, we surface it to staff so it
 *      is never a SILENT loss.
 *   2) A 'created' row with no capture, older than the window, is an abandoned checkout — close it
 *      as 'expired' so open orders don't pile up (and a reused-order lookup stays clean).
 */
async function reconcileStuckPayments({ now = new Date() } = {}) {
  const processingCutoff = new Date(now.getTime() - STUCK_PROCESSING_MINUTES * 60000);
  const createdCutoff = new Date(now.getTime() - ABANDONED_CREATED_MINUTES * 60000);
  let recovered = 0;
  let flagged = 0;

  const stuck = await Payment.find({ status: 'processing', paymentId: { $type: 'string' }, updatedAt: { $lt: processingCutoff } }).limit(200);
  for (const p of stuck) {
    const ctx = { clinicId: p.clinicId, actorId: 'system:reconcile', actorRole: null };
    try {
      const r = await claimAndApply(ctx, { orderId: p.orderId, paymentId: p.paymentId, method: p.method || 'online' });
      if (r.applied) recovered += 1;
    } catch (err) {
      flagged += 1;
      require('./notificationService')
        .emit(ctx, { type: 'other', message: `A payment needs manual reconciliation (order ${p.orderId}) — money may have been captured. Please check the gateway.`, link: '/billing' })
        .catch(() => {});
    }
  }

  const abandoned = await Payment.updateMany(
    { status: 'created', paymentId: null, createdAt: { $lt: createdCutoff } },
    { $set: { status: 'expired' } }
  );

  return { recovered, flagged, expired: abandoned.modifiedCount || abandoned.nModified || 0 };
}

module.exports = { createInvoiceOrder, verifyPayment, handleWebhook, claimAndApply, reconcileStuckPayments, refundForInvoice };
