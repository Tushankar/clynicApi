'use strict';

/**
 * Phase 3 adversarial-audit regressions. Locks in the confirmed fixes:
 *   - cross-patient payment verify is rejected (portal ownership check)
 *   - a webhook whose side effect fails is safely retried — credits exactly once
 *     (no money lost, no double credit)
 *   - a subscription.halted webhook audits the past_due transition
 *   - a verified prepayment persists the capturing paymentId on the appointment
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Payment, Invoice, Subscription, AuditLog } = require('../src/models');
const patientService = require('../src/services/patientService');
const invoiceService = require('../src/services/invoiceService');
const paymentService = require('../src/services/paymentService');
const prepaymentService = require('../src/services/prepaymentService');
const subscriptionService = require('../src/services/subscriptionService');
const appointmentService = require('../src/services/appointmentService');
const doctorService = require('../src/services/doctorService');
const branchService = require('../src/services/branchService');
const portalService = require('../src/services/portalService');
const gateway = require('../src/lib/payments');

const ctxA = { clinicId: 'org_A', actorId: 'ua', actorRole: 'owner' };
let mongod;
let doctorA;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Payment.init(), Invoice.init()]);
  await Clinic.create({ clinicId: 'org_A', name: 'A', slug: 'a3a', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_sub', name: 'Sub', slug: 's3a', subscriptionPlan: 'standard' });
  await branchService.getOrCreatePrimaryBranch(ctxA);
  doctorA = await doctorService.createDoctor(ctxA, 'standard', { name: 'Dr. Fee', consultationFee: 500, slotDurationMinutes: 30 });
});

after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// --- Fix 1: a patient cannot verify/credit another patient's invoice order -----------
test('cross-patient payment verify is rejected (portal ownership)', async () => {
  const victim = await patientService.createPatient(ctxA, { name: 'Victim', phone: '11', email: 'v@x.com' });
  const attacker = await patientService.createPatient(ctxA, { name: 'Attacker', phone: '12', email: 'a@x.com' });
  const inv = await invoiceService.create(ctxA, { patientId: victim._id, items: [{ description: 'Consult', amount: 200 }], gstRate: 0 });

  const reqVictim = { ctx: ctxA, patient: { clinicId: 'org_A', patientId: String(victim._id) } };
  const reqAttacker = { ctx: ctxA, patient: { clinicId: 'org_A', patientId: String(attacker._id) } };

  const order = await portalService.payInvoiceOrder(reqVictim, inv._id);
  const paymentId = 'pay_xpatient_1';
  const signature = gateway.devSignPayment(order.orderId, paymentId);

  // Attacker holds a VALID signature but does not own the order → rejected, nothing credited.
  await assert.rejects(
    () => portalService.payInvoiceVerify(reqAttacker, { orderId: order.orderId, paymentId, signature }),
    (e) => e.statusCode === 404,
    'another patient cannot verify this order'
  );
  assert.equal((await invoiceService.getById(ctxA, inv._id)).amountPaid, 0, 'no credit from cross-patient attempt');

  // The real owner can.
  const ok = await portalService.payInvoiceVerify(reqVictim, { orderId: order.orderId, paymentId, signature });
  assert.equal(ok.applied, true);
  assert.equal((await invoiceService.getById(ctxA, inv._id)).amountPaid, 200);
  console.log('  ✓ cross-patient verify rejected; owner credits once');
});

// --- Fix 2 (hardened): a webhook whose apply fails is retried → credits exactly once ---
test('webhook side-effect failure is retried safely (no lost/double credit)', async () => {
  const p = await patientService.createPatient(ctxA, { name: 'Retry Pat', phone: '13' });
  const inv = await invoiceService.create(ctxA, { patientId: p._id, items: [{ description: 'Consult', amount: 500 }], gstRate: 18 });
  const order = await paymentService.createInvoiceOrder(ctxA, inv._id);

  const body = JSON.stringify({
    id: 'evt_retry_1',
    event: 'payment.captured',
    payload: { payment: { entity: { order_id: order.orderId, id: 'pay_retry_1', amount: 59000, method: 'upi' } } },
  });
  const sig = gateway.devSignWebhook(body);

  // Force the credit to fail on the FIRST delivery only.
  const orig = invoiceService.recordPayment;
  let calls = 0;
  invoiceService.recordPayment = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('transient credit failure');
    return orig.apply(invoiceService, args);
  };

  try {
    await assert.rejects(() => paymentService.handleWebhook(body, sig, 'evt_retry_1'), 'first delivery surfaces the failure');
    let fresh = await invoiceService.getById(ctxA, inv._id);
    assert.equal(fresh.amountPaid, 0, 'nothing credited yet');
    let pay = await Payment.findOne({ clinicId: 'org_A', orderId: order.orderId }).lean();
    assert.equal(pay.status, 'processing', 'order left re-claimable (not stuck paid)');

    // Provider retries the SAME event → now credits exactly once.
    const retry = await paymentService.handleWebhook(body, sig, 'evt_retry_1');
    assert.equal(retry.processed, true);
    fresh = await invoiceService.getById(ctxA, inv._id);
    assert.equal(fresh.amountPaid, 590, 'credited once on retry');
    assert.equal(fresh.status, 'paid');
    pay = await Payment.findOne({ clinicId: 'org_A', orderId: order.orderId }).lean();
    assert.equal(pay.status, 'paid');

    // A genuine duplicate after success is a no-op.
    const dup = await paymentService.handleWebhook(body, sig, 'evt_retry_1');
    assert.equal(dup.duplicate, true);
    assert.equal((await invoiceService.getById(ctxA, inv._id)).amountPaid, 590, 'still once (idempotent)');
  } finally {
    invoiceService.recordPayment = orig;
  }
  console.log('  ✓ failed apply is retried → credited exactly once (no lost/double credit)');
});

// --- Fix 5: subscription.halted audits the past_due transition -----------------------
test('subscription.halted webhook audits the past_due transition', async () => {
  await subscriptionService.applySubscription('org_sub', 'standard', 'active'); // seed an active sub
  const body = JSON.stringify({ id: 'sub_halt_1', event: 'subscription.halted', payload: { subscription: { entity: { id: 'sub_x', notes: { clinicId: 'org_sub' } } } } });
  await paymentService.handleWebhook(body, gateway.devSignWebhook(body), 'sub_halt_1');

  const sub = await Subscription.findOne({ clinicId: 'org_sub' }).lean();
  assert.equal(sub.status, 'past_due', 'subscription moved to past_due');
  const logs = await AuditLog.find({ clinicId: 'org_sub', entityType: 'Subscription' }).lean();
  assert.ok(logs.some((l) => l.after && l.after.status === 'past_due'), 'past_due transition is audited');
  console.log('  ✓ subscription.halted → past_due is audited');
});

// --- Fix 8: a verified prepayment persists the capturing paymentId -------------------
test('verified prepayment links the capturing paymentId on the appointment', async () => {
  const p = await patientService.createPatient(ctxA, { name: 'Link Pat', phone: '14', email: 'lp@x.com' });
  const appt = await appointmentService.book(ctxA, { doctorId: doctorA._id, patientId: p._id, scheduledAt: new Date(Date.now() + 86400000), source: 'online' });
  const order = await prepaymentService.createOrder(ctxA, appt._id);
  const paymentId = 'pay_link_1';
  const signature = gateway.devSignPayment(order.orderId, paymentId);
  await paymentService.verifyPayment(ctxA, { orderId: order.orderId, paymentId, signature });

  const fresh = await appointmentService.getById(ctxA, appt._id);
  assert.equal(fresh.prepaid, true);
  assert.equal(fresh.status, 'confirmed');
  assert.equal(fresh.prepaymentId, paymentId, 'appointment records which payment captured it');
  console.log('  ✓ prepayment persists the capturing paymentId + confirms');
});
