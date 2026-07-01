'use strict';

/**
 * Phase 3 verification — checks (b) prepayment, (c) subscription loop, (d) super-admin
 * analytics, (e) hard rules on money collections. Check (a) payment security is proven
 * in phase3-payments.test.js.
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';
process.env.SUPER_ADMIN_IDS = 'user_admin';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Invoice, AuditLog, Appointment, Payment } = require('../src/models');
const { createApp } = require('../src/app');
const branchService = require('../src/services/branchService');
const doctorService = require('../src/services/doctorService');
const patientService = require('../src/services/patientService');
const appointmentService = require('../src/services/appointmentService');
const prepaymentService = require('../src/services/prepaymentService');
const paymentService = require('../src/services/paymentService');
const invoiceService = require('../src/services/invoiceService');
const gateway = require('../src/lib/payments');

const ctxA = { clinicId: 'org_A', actorId: 'ua', actorRole: 'owner' };
const ctxB = { clinicId: 'org_B', actorId: 'ub', actorRole: 'owner' };
let mongod;
let server;
let base;
let doctorA;

function hdr(clinicId, role = 'owner', userId = `u_${clinicId}`) {
  return { 'content-type': 'application/json', 'x-dev-clinic-id': clinicId, 'x-dev-role': role, 'x-dev-user-id': userId };
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Payment.init(), Invoice.init()]);
  await Clinic.create({ clinicId: 'org_A', name: 'A', slug: 'a3v', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_B', name: 'B', slug: 'b3v', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_basic', name: 'Basic', slug: 'basic3v', subscriptionPlan: 'basic' });
  await branchService.getOrCreatePrimaryBranch(ctxA);
  doctorA = await doctorService.createDoctor(ctxA, 'standard', { name: 'Dr. Fee', consultationFee: 500, slotDurationMinutes: 30 });

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

// ---------------------------------------------------------------------------
test('(b) prepayment: unpaid appointment stays unconfirmed; verified-paid is confirmed', async () => {
  const p = await patientService.createPatient(ctxA, { name: 'Prepay Pat', phone: '7', email: 'pp@x.com' });
  const appt = await appointmentService.book(ctxA, { doctorId: doctorA._id, patientId: p._id, scheduledAt: new Date(Date.now() + 86400000), source: 'online' });
  assert.equal(appt.status, 'booked', 'unpaid appointment is not confirmed');
  assert.equal(appt.prepaid, false);

  const order = await prepaymentService.createOrder(ctxA, appt._id);
  const paymentId = 'pay_prepay_1';
  const signature = gateway.devSignPayment(order.orderId, paymentId);
  const res = await paymentService.verifyPayment(ctxA, { orderId: order.orderId, paymentId, signature });
  assert.equal(res.applied, true);

  const fresh = await appointmentService.getById(ctxA, appt._id);
  assert.equal(fresh.prepaid, true, 'appointment marked prepaid after verified payment');
  assert.equal(fresh.status, 'confirmed', 'appointment confirmed after verified payment');
  console.log('  ✓ (b) prepayment: unpaid → unconfirmed; verified-paid → confirmed + prepaid');
});

// ---------------------------------------------------------------------------
test('(c) subscription loop: webhook flips clinics.subscriptionPlan; plan gating reflects it (no code change)', async () => {
  // Basic clinic is blocked from a Standard feature.
  const before = await fetch(`${base}/api/invoices`, { headers: hdr('org_basic') });
  assert.equal(before.status, 403, 'Basic clinic blocked from BILLING');

  // A verified subscription webhook activates Standard.
  const upBody = JSON.stringify({ id: 'sub_evt_up', event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_1', notes: { clinicId: 'org_basic', plan: 'standard' } } } } });
  const upSig = gateway.devSignWebhook(upBody);
  const up = await fetch(`${base}/api/payments/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': upSig, 'x-razorpay-event-id': 'sub_evt_up' }, body: upBody });
  assert.equal(up.status, 200);
  assert.equal((await Clinic.findOne({ clinicId: 'org_basic' }).lean()).subscriptionPlan, 'standard', 'clinic plan upgraded by webhook');

  // Gating now allows BILLING — with NO code change.
  const afterUp = await fetch(`${base}/api/invoices`, { headers: hdr('org_basic') });
  assert.equal(afterUp.status, 200, 'upgrade unlocks the gated feature immediately');

  // Cancellation downgrades → feature locks again.
  const downBody = JSON.stringify({ id: 'sub_evt_down', event: 'subscription.cancelled', payload: { subscription: { entity: { id: 'sub_1', notes: { clinicId: 'org_basic', plan: 'standard' } } } } });
  const downSig = gateway.devSignWebhook(downBody);
  await fetch(`${base}/api/payments/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': downSig, 'x-razorpay-event-id': 'sub_evt_down' }, body: downBody });
  assert.equal((await Clinic.findOne({ clinicId: 'org_basic' }).lean()).subscriptionPlan, 'basic', 'cancellation downgraded the clinic');
  const afterDown = await fetch(`${base}/api/invoices`, { headers: hdr('org_basic') });
  assert.equal(afterDown.status, 403, 'downgrade re-locks the gated feature');

  console.log('  ✓ (c) subscription webhook drives plan gating both ways (no code change)');
});

// ---------------------------------------------------------------------------
test('(d) super-admin analytics: Super-Admin only, aggregates only, no patient data, clinic users blocked', async () => {
  // Clinic user (not allowlisted) → 403.
  const asClinic = await fetch(`${base}/api/admin/analytics`, { headers: hdr('org_A', 'owner', 'u_clinic') });
  assert.equal(asClinic.status, 403, 'clinic users cannot reach platform analytics');

  // Super admin → 200 aggregates.
  const asAdmin = await fetch(`${base}/api/admin/analytics`, { headers: hdr('org_A', 'owner', 'user_admin') });
  assert.equal(asAdmin.status, 200);
  const data = await asAdmin.json();
  assert.ok(typeof data.revenue.mrr === 'number' && typeof data.clinics.total === 'number', 'aggregate numbers present');
  assert.ok(data.clinics.total >= 3, 'counts across all clinics (cross-tenant aggregate)');
  // No patient data leaks into the aggregate payload.
  const json = JSON.stringify(data).toLowerCase();
  assert.ok(!json.includes('patientname') && !json.includes('"patientid"') && !json.includes('prepay pat'), 'no patient data in analytics');
  console.log('  ✓ (d) super-admin only, aggregates correct, clinic users blocked, no patient-data leak');
});

// ---------------------------------------------------------------------------
test('(e) hard rules: invoices soft-deletable + audited + tenant-isolated', async () => {
  const p = await patientService.createPatient(ctxA, { name: 'Inv Pat', phone: '8' });
  const inv = await invoiceService.create(ctxA, { patientId: p._id, items: [{ description: 'Consult', amount: 300 }], gstRate: 0 });
  assert.ok(inv.branchId, 'invoice carries branchId');

  // Audit on create.
  const logs = await AuditLog.find({ clinicId: 'org_A', entityType: 'Invoice', entityId: inv._id }).lean();
  assert.ok(logs.some((l) => l.action === 'create'), 'invoice create audited');

  // Tenant isolation: clinic B can't see it.
  assert.equal((await invoiceService.list(ctxB, {})).length, 0, 'clinic B cannot list clinic A invoices');

  // Soft delete: excluded from default list, row remains with deletedAt.
  await invoiceService.softDelete(ctxA, inv._id);
  assert.ok(!(await invoiceService.list(ctxA, {})).some((x) => String(x._id) === String(inv._id)), 'soft-deleted invoice excluded');
  const raw = await Invoice.findById(inv._id).lean();
  assert.ok(raw && raw.deletedAt && raw.deletedBy === 'ua', 'row persists with deletedAt/deletedBy');
  const delLogs = await AuditLog.find({ clinicId: 'org_A', entityType: 'Invoice', entityId: inv._id, action: 'delete' });
  assert.equal(delLogs.length, 1, 'invoice delete audited');

  console.log('  ✓ (e) invoices: branchId, audited (create+delete), tenant-isolated, soft-deletable');
});
