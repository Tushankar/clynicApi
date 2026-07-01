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
  await applyCapture(ctx, claimed); // idempotent — see above
  await Payment.updateOne({ clinicId: ctx.clinicId, _id: claimed._id }, { $set: { status: 'paid' } });
  await auditCapture(ctx, claimed);
  return { applied: true, paymentId, status: 'paid' };
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
  } else if (type.startsWith('subscription.')) {
    await require('./subscriptionService').handleSubscriptionWebhook(event);
  }

  // Side effect succeeded — now durably record the event so retries are no-ops.
  await WebhookEvent.create({ provider, eventId, type: event.event }).catch((err) => {
    if (err.code !== 11000) throw err;
  });
  return { processed: true };
}

module.exports = { createInvoiceOrder, verifyPayment, handleWebhook, claimAndApply };
