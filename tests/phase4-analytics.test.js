'use strict';

/**
 * Phase 4 · Step 4 — owner analytics.
 * Proves: ANALYTICS is Premium-gated; clinic-scoped aggregations (revenue, no-show rate,
 * new vs returning, most-visited doctor) are correct AND never include another clinic's data.
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Patient, Invoice, Appointment } = require('../src/models');
const { createApp } = require('../src/app');
const analyticsService = require('../src/services/analyticsService');

let mongod;
let server;
let base;
const DAY = 24 * 3600 * 1000;
const ctx = (clinicId) => ({ clinicId, actorId: `u_${clinicId}`, actorRole: 'owner' });
const hdr = (clinicId) => ({ 'content-type': 'application/json', 'x-dev-clinic-id': clinicId, 'x-dev-role': 'owner', 'x-dev-user-id': `u_${clinicId}` });

let seq = 0;
const DR_A = new mongoose.Types.ObjectId(); // one stable doctor for the "most-visited" test
async function appt(clinicId, { status, doctorName = 'Dr A', doctorId = DR_A, patientId, when = new Date() }) {
  return new Appointment({ clinicId, branchId: new mongoose.Types.ObjectId(), patientId: patientId || new mongoose.Types.ObjectId(), doctorId, doctorName, scheduledAt: when, status, patientName: 'X' }).save();
}
async function invoice(clinicId, amountPaid) {
  seq += 1;
  return Invoice.create({ clinicId, branchId: new mongoose.Types.ObjectId(), invoiceNumber: `INV-A${seq}`, patientId: new mongoose.Types.ObjectId(), patientName: 'X', items: [{ description: 'c', amount: amountPaid }], subtotal: amountPaid, total: amountPaid, amountPaid, status: 'paid' });
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Patient.init(), Invoice.init(), Appointment.init()]);
  await Clinic.create({ clinicId: 'org_an', name: 'Analytics Clinic', slug: 'an4', subscriptionPlan: 'premium' });
  await Clinic.create({ clinicId: 'org_std', name: 'Std', slug: 'std4an', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_other', name: 'Other', slug: 'oth4an', subscriptionPlan: 'premium' });

  const now = new Date();
  // org_an: a "new" patient (created now) + a "returning" patient (created 60d ago), both seen now.
  const newP = await new Patient({ clinicId: 'org_an', patientCode: 'P90001', name: 'New P' }).save();
  const retP = await new Patient({ clinicId: 'org_an', patientCode: 'P90002', name: 'Ret P' }).save();
  await Patient.collection.updateOne({ _id: retP._id }, { $set: { createdAt: new Date(now - 60 * DAY) } });

  await appt('org_an', { status: 'completed', patientId: newP._id });
  await appt('org_an', { status: 'completed', patientId: retP._id });
  await appt('org_an', { status: 'no_show' });
  await appt('org_an', { status: 'cancelled' });
  await invoice('org_an', 500);
  await invoice('org_an', 300);

  // org_other noise that must NOT leak into org_an analytics.
  await appt('org_other', { status: 'no_show' });
  await invoice('org_other', 9999);

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

test('(b) ANALYTICS is Premium-gated: Standard 403, Premium 200', async () => {
  const blocked = await fetch(`${base}/api/analytics/overview`, { headers: hdr('org_std') });
  assert.equal(blocked.status, 403);
  const ok = await fetch(`${base}/api/analytics/overview`, { headers: hdr('org_an') });
  assert.equal(ok.status, 200);
  console.log('  ✓ (b) analytics gated: Standard 403, Premium 200');
});

test('(d) clinic-scoped aggregations are correct and isolated', async () => {
  const a = await analyticsService.overview(ctx('org_an'), {});
  assert.equal(a.revenue.total, 800, 'revenue sums only this clinic (500+300, not org_other 9999)');
  assert.equal(a.revenue.invoices, 2);
  assert.equal(a.appointments.total, 4);
  // expected = total - cancelled = 3; no_show = 1 → 33.3%
  assert.equal(a.appointments.noShowRate, 33.3, 'no-show rate excludes cancellations');
  assert.equal(a.patients.seen, 2, 'two distinct patients seen');
  assert.equal(a.patients.new, 1, 'one new patient');
  assert.equal(a.patients.returning, 1, 'one returning patient');
  assert.equal(a.doctors.mostVisited[0].name, 'Dr A');
  assert.equal(a.doctors.mostVisited[0].count, 2);

  // Isolation: org_other's revenue/appts never appear here.
  const other = await analyticsService.overview(ctx('org_other'), {});
  assert.equal(other.revenue.total, 9999, 'org_other sees only its own revenue');
  assert.equal(other.appointments.total, 1);
  console.log('  ✓ (d) analytics aggregations correct + strictly clinic-scoped');
});
