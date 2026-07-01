'use strict';

/**
 * Phase 4 · Step 3 — CRM & retention.
 * Proves: CRM is Premium-gated; completing a visit maintains lastVisitAt/visitCount +
 * auto-'repeat' tag; retention aggregations are correct AND strictly clinic-scoped
 * (no cross-clinic leakage); re-engage requires an email on file.
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
const crmService = require('../src/services/crmService');
const appointmentService = require('../src/services/appointmentService');

let mongod;
let server;
let base;
const DAY = 24 * 3600 * 1000;
const ctx = (clinicId) => ({ clinicId, actorId: `u_${clinicId}`, actorRole: 'owner' });
const hdr = (clinicId) => ({ 'content-type': 'application/json', 'x-dev-clinic-id': clinicId, 'x-dev-role': 'owner', 'x-dev-user-id': `u_${clinicId}` });

let seq = 0;
function mkPatient(clinicId, fields) {
  seq += 1;
  return new Patient({ clinicId, patientCode: `P${String(seq).padStart(5, '0')}`, name: fields.name || `Pat ${seq}`, ...fields }).save();
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Patient.init(), Invoice.init(), Appointment.init()]);
  await Clinic.create({ clinicId: 'org_crm', name: 'Retention Clinic', slug: 'crm4', subscriptionPlan: 'premium' });
  await Clinic.create({ clinicId: 'org_std', name: 'Std', slug: 'std4crm', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_other', name: 'Other', slug: 'oth4crm', subscriptionPlan: 'premium' });
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

test('(b) CRM is Premium-gated: Standard 403, Premium 200', async () => {
  const blocked = await fetch(`${base}/api/crm/summary`, { headers: hdr('org_std') });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error, 'upgrade_required');
  const ok = await fetch(`${base}/api/crm/summary`, { headers: hdr('org_crm') });
  assert.equal(ok.status, 200);
  console.log('  ✓ (b) CRM gated: Standard 403, Premium 200');
});

test('(d) completing a visit maintains visitCount/lastVisitAt + auto-repeat tag', async () => {
  const c = ctx('org_crm');
  const p = await mkPatient('org_crm', { name: 'Visitor', visitCount: 1, tags: [] });
  const appt = await new Appointment({ clinicId: 'org_crm', branchId: new mongoose.Types.ObjectId(), patientId: p._id, doctorId: new mongoose.Types.ObjectId(), scheduledAt: new Date(), status: 'in_consultation', patientName: 'Visitor' }).save();

  await appointmentService.transition(c, appt._id, 'completed');
  const fresh = await Patient.findById(p._id).lean();
  assert.equal(fresh.visitCount, 2, 'visitCount incremented on completion');
  assert.ok(fresh.lastVisitAt, 'lastVisitAt set');
  assert.ok(fresh.tags.includes('repeat'), 'auto-tagged repeat at 2nd visit');
  console.log('  ✓ (d) visit completion updates CRM fields + repeat tag');
});

test('(d) retention aggregations are correct and clinic-scoped', async () => {
  const now = new Date();
  // org_crm seed
  await mkPatient('org_crm', { name: 'Lapsed A', lastVisitAt: new Date(now - 200 * DAY), visitCount: 1 });
  await mkPatient('org_crm', { name: 'Repeat A', visitCount: 4, lastVisitAt: new Date(now - 10 * DAY) });
  const hv = await mkPatient('org_crm', { name: 'Whale A', visitCount: 3 });
  await Invoice.create({ clinicId: 'org_crm', branchId: new mongoose.Types.ObjectId(), invoiceNumber: 'INV-CRM1', patientId: hv._id, patientName: 'Whale A', items: [{ description: 'x', amount: 5000 }], subtotal: 5000, total: 5000, amountPaid: 5000, status: 'paid' });
  await mkPatient('org_crm', { name: 'Bday A', dob: new Date(1990, now.getMonth(), now.getDate()) }); // birthday today
  await mkPatient('org_crm', { name: 'FollowUp A', followUpAt: new Date(now.getTime() + 2 * DAY) });

  // Cross-clinic noise that must NOT be counted for org_crm.
  await mkPatient('org_other', { name: 'Lapsed OTHER', lastVisitAt: new Date(now - 300 * DAY), visitCount: 1 });

  const s = await crmService.summary(ctx('org_crm'), now);
  assert.ok(s.counts.lapsed >= 1, 'lapsed counted');
  assert.ok(s.counts.repeat >= 2, 'repeat counted (Repeat A + Whale A + the visit-tracking Visitor)');
  assert.ok(s.counts.highValue >= 1 && s.highValue[0].revenue === 5000, 'high-value by revenue');
  assert.ok(s.counts.birthdays >= 1, 'birthday within 30d counted');
  assert.ok(s.counts.followupsDue >= 1, 'follow-up due within 7d counted');

  // Clinic scope: org_other's lapsed patient must not appear in org_crm's lapsed list.
  const lapsedRows = await crmService.segment(ctx('org_crm'), 'lapsed', {}, now);
  assert.ok(lapsedRows.every((r) => r.name !== 'Lapsed OTHER'), 'no cross-clinic patient in the segment');
  const otherSummary = await crmService.summary(ctx('org_other'), now);
  assert.equal(otherSummary.counts.repeat, 0, 'org_other has no repeat patients (isolation)');
  console.log('  ✓ (d) aggregations correct + strictly clinic-scoped');
});

test('re-engage requires an email on file', async () => {
  const noEmail = await mkPatient('org_crm', { name: 'NoEmail', lastVisitAt: new Date(Date.now() - 200 * DAY) });
  await assert.rejects(() => crmService.reengage(ctx('org_crm'), noEmail._id), (e) => e.statusCode === 400);

  const withEmail = await mkPatient('org_crm', { name: 'HasEmail', email: 'reengage@x.com', lastVisitAt: new Date(Date.now() - 200 * DAY) });
  const res = await crmService.reengage({ ...ctx('org_crm'), clinicName: 'Retention Clinic' }, withEmail._id);
  assert.equal(res.ok, true);
  assert.equal(res.channel, 'email');
  console.log('  ✓ re-engage sends for patients with email, 400 without');
});
