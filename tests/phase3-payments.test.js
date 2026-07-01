'use strict';

/**
 * Step 4 proof — payment security (payment rules 1 + 2).
 * Proves: orders are created server-side; a forged / client-only "paid" is rejected;
 * a verified signature credits the invoice exactly once; replaying the callback or
 * the webhook never double-credits (idempotent).
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Payment, Invoice } = require('../src/models');
const { createApp } = require('../src/app');
const patientService = require('../src/services/patientService');
const invoiceService = require('../src/services/invoiceService');
const gateway = require('../src/lib/payments');

const ctxA = { clinicId: 'org_A', actorId: 'ua', actorRole: 'owner' };
let mongod;
let server;
let base;

const hdr = { 'content-type': 'application/json', 'x-dev-clinic-id': 'org_A', 'x-dev-role': 'owner', 'x-dev-user-id': 'ua' };

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Payment.init(), Invoice.init()]); // ensure unique indexes are built before tests
  await Clinic.create({ clinicId: 'org_A', name: 'A', slug: 'a3', subscriptionPlan: 'standard' });
  const app = createApp();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function makeInvoice() {
  const p = await patientService.createPatient(ctxA, { name: 'Pay Patient', phone: '5' });
  return invoiceService.create(ctxA, { patientId: p._id, items: [{ description: 'Consultation', amount: 500 }], gstRate: 18 });
}

test('order is created server-side for the invoice outstanding (₹590 = 500 + 18% GST)', async () => {
  const inv = await makeInvoice();
  assert.equal(inv.total, 590);
  const res = await fetch(`${base}/api/payments/invoice/${inv._id}/order`, { method: 'POST', headers: hdr });
  assert.equal(res.status, 200);
  const order = await res.json();
  assert.ok(order.orderId && order.amount === 590);
  console.log('  ✓ server-side order created for the exact outstanding amount');
});

test('(a) forged / client-only "paid" is rejected; a verified signature credits once; replay is idempotent', async () => {
  const inv = await makeInvoice();
  const order = await (await fetch(`${base}/api/payments/invoice/${inv._id}/order`, { method: 'POST', headers: hdr })).json();
  const paymentId = 'pay_test_1';

  // Forged signature → rejected, nothing credited.
  const forged = await fetch(`${base}/api/payments/verify`, { method: 'POST', headers: hdr, body: JSON.stringify({ orderId: order.orderId, paymentId, signature: 'totally-fake' }) });
  assert.equal(forged.status, 400, 'forged signature rejected server-side');
  assert.equal((await invoiceService.getById(ctxA, inv._id)).amountPaid, 0, 'no credit from a forged payment');

  // Valid signature (the gateway would produce this) → credited exactly once.
  const signature = gateway.devSignPayment(order.orderId, paymentId);
  const ok = await fetch(`${base}/api/payments/verify`, { method: 'POST', headers: hdr, body: JSON.stringify({ orderId: order.orderId, paymentId, signature }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).applied, true);
  let fresh = await invoiceService.getById(ctxA, inv._id);
  assert.equal(fresh.amountPaid, 590);
  assert.equal(fresh.status, 'paid');

  // Replay the exact same verified callback → idempotent, no double credit.
  const replay = await fetch(`${base}/api/payments/verify`, { method: 'POST', headers: hdr, body: JSON.stringify({ orderId: order.orderId, paymentId, signature }) });
  assert.equal((await replay.json()).applied, false, 'replay not applied again');
  fresh = await invoiceService.getById(ctxA, inv._id);
  assert.equal(fresh.amountPaid, 590, 'amount unchanged on replay (no double credit)');

  console.log('  ✓ (a) forged paid rejected; verified credits once; callback replay idempotent');
});

test('(a) webhook is signature-verified and idempotent (replay does not double-credit)', async () => {
  const inv = await makeInvoice();
  const order = await (await fetch(`${base}/api/payments/invoice/${inv._id}/order`, { method: 'POST', headers: hdr })).json();

  const body = JSON.stringify({
    id: 'evt_unique_1',
    event: 'payment.captured',
    payload: { payment: { entity: { order_id: order.orderId, id: 'pay_wh_1', amount: 59000, method: 'upi' } } },
  });
  const sig = gateway.devSignWebhook(body);
  const post = () => fetch(`${base}/api/payments/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_unique_1' }, body });

  // Bad signature → rejected.
  const bad = await fetch(`${base}/api/payments/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'nope', 'x-razorpay-event-id': 'evt_unique_1' }, body });
  assert.equal(bad.status, 400, 'webhook with bad signature rejected');

  const first = await post();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).processed, true);
  assert.equal((await invoiceService.getById(ctxA, inv._id)).amountPaid, 590, 'credited once');

  const second = await post(); // replay
  assert.equal((await second.json()).duplicate, true, 'replayed event is a no-op');
  assert.equal((await invoiceService.getById(ctxA, inv._id)).amountPaid, 590, 'still credited only once (idempotent)');

  console.log('  ✓ (a) webhook signature-verified + idempotent (replay never double-credits)');
});
