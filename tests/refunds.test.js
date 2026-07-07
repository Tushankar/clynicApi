'use strict';

/**
 * Gateway-side refunds — proves a refund now actually returns money through the payment gateway
 * (Razorpay refund API, exercised via the mock adapter) and is recorded on the Payment, instead of
 * only updating the invoice books. Also covers: cannot exceed paid, cash refunds need no gateway
 * leg, and a refund.failed webhook flags the failure for staff.
 */
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Patient, Invoice, Payment, WebhookEvent } = require('../src/models');
const { tenantRepo } = require('../src/lib/TenantRepository');
const invoiceService = require('../src/services/invoiceService');
const paymentService = require('../src/services/paymentService');
const gateway = require('../src/lib/payments');

const ctx = { clinicId: 'org_ref', actorId: 'owner1', actorRole: 'owner' };
let mongod;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Invoice.deleteMany({}), Payment.deleteMany({}), Patient.deleteMany({}), WebhookEvent.deleteMany({})]);
});

async function paidOnlineInvoice(total, suffix) {
  const p = await tenantRepo(Patient, ctx).create({ name: 'Pay Pat', patientCode: `PP${suffix}` });
  const inv = await invoiceService.create(ctx, { patientId: p._id, items: [{ description: 'Consult', amount: total, quantity: 1 }], gstRate: 0 });
  const order = await paymentService.createInvoiceOrder(ctx, inv._id);
  const paymentId = `pay_test_${suffix}`;
  const signature = gateway.devSignPayment(order.orderId, paymentId);
  await paymentService.verifyPayment(ctx, { orderId: order.orderId, paymentId, signature });
  return { inv, paymentId };
}

test('online refund calls the gateway and records it on the payment (partial → full)', async () => {
  const { inv, paymentId } = await paidOnlineInvoice(1000, 'full');

  const afterPartial = await invoiceService.refund(ctx, inv._id, { amount: 400, reason: 'partial' });
  assert.equal(afterPartial.amountRefunded, 400, 'invoice books reflect the refund');

  let pay = await Payment.findOne({ clinicId: ctx.clinicId, paymentId });
  assert.equal(pay.amountRefunded, 400, 'gateway refund recorded on the payment (was: never called)');
  assert.equal(pay.refunds.length, 1);
  assert.match(pay.refunds[0].refundId, /^rfnd_/);
  assert.equal(pay.refunds[0].status, 'processed');
  assert.equal(pay.status, 'paid', 'still paid — only partially refunded');

  const afterFull = await invoiceService.refund(ctx, inv._id, { amount: 600, reason: 'rest' });
  assert.equal(afterFull.amountRefunded, 1000);
  assert.equal(afterFull.status, 'refunded', 'invoice fully refunded');
  pay = await Payment.findOne({ clinicId: ctx.clinicId, paymentId });
  assert.equal(pay.amountRefunded, 1000);
  assert.equal(pay.status, 'refunded', 'payment fully refunded via the gateway');
  console.log('  ✓ online refunds hit the gateway + are recorded on the payment; partial→full correct');
});

test('a refund cannot exceed the paid amount', async () => {
  const { inv } = await paidOnlineInvoice(500, 'cap');
  await assert.rejects(() => invoiceService.refund(ctx, inv._id, { amount: 600 }), /exceeds the paid amount/i);
});

test('cash-paid refund needs no gateway leg (still updates the books)', async () => {
  const p = await tenantRepo(Patient, ctx).create({ name: 'Cash Pat', patientCode: 'CP1' });
  const inv = await invoiceService.create(ctx, { patientId: p._id, items: [{ description: 'Consult', amount: 500, quantity: 1 }], gstRate: 0 });
  await invoiceService.recordPayment(ctx, inv._id, { amount: 500, method: 'cash' });
  const refunded = await invoiceService.refund(ctx, inv._id, { amount: 200, reason: 'cash back' });
  assert.equal(refunded.amountRefunded, 200);
  const anyRefundPayment = await Payment.findOne({ clinicId: ctx.clinicId, 'refunds.0': { $exists: true } });
  assert.equal(anyRefundPayment, null, 'no gateway refund for a cash-only invoice');
  console.log('  ✓ cash refund updates the books with no gateway call');
});

test('refund.failed webhook flags the refund (money may not have reached the patient)', async () => {
  const { inv, paymentId } = await paidOnlineInvoice(300, 'wh');
  await invoiceService.refund(ctx, inv._id, { amount: 300, reason: 'full' });
  let pay = await Payment.findOne({ clinicId: ctx.clinicId, paymentId });
  const realRefundId = pay.refunds[0].refundId;

  const event = { id: 'evt_ref_fail_1', event: 'refund.failed', payload: { refund: { entity: { id: realRefundId, payment_id: paymentId, amount: 30000, status: 'failed' } } } };
  const raw = Buffer.from(JSON.stringify(event));
  await paymentService.handleWebhook(raw, gateway.devSignWebhook(raw), event.id);

  pay = await Payment.findOne({ clinicId: ctx.clinicId, paymentId });
  const entry = pay.refunds.find((r) => r.refundId === realRefundId);
  assert.equal(entry.status, 'failed', 'the webhook flipped the refund to failed for staff follow-up');
  console.log('  ✓ refund.failed webhook records the failure');
});
