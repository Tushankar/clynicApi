'use strict';

/**
 * Clinic profile editing (Settings → shows on the public website).
 * Proves: owner can PATCH /me/clinic (name/address/phone/gst); it's reflected by GET /me AND
 * by the public site; non-owners are blocked (RBAC); the change is audited (rule 7).
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, AuditLog } = require('../src/models');
const { createApp } = require('../src/app');
const websiteService = require('../src/services/websiteService');

let mongod;
let server;
let base;
const hdr = (role = 'owner') => ({ 'content-type': 'application/json', 'x-dev-clinic-id': 'org_c1', 'x-dev-role': role, 'x-dev-user-id': 'u1' });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Clinic.create({ clinicId: 'org_c1', name: 'Clynic', slug: 'clynic-1', subscriptionPlan: 'premium', website: { published: true } });
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

test('owner updates clinic profile; /me + public site reflect it; audited', async () => {
  // Initially no address.
  const me0 = await (await fetch(`${base}/api/me`, { headers: hdr('owner') })).json();
  assert.equal(me0.clinic.address, '');

  const res = await fetch(`${base}/api/me/clinic`, { method: 'PATCH', headers: hdr('owner'), body: JSON.stringify({ address: '12 Park Street, Kolkata 700016', phone: '033-4000-1000' }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).clinic.address, '12 Park Street, Kolkata 700016');

  // GET /me now reflects it.
  const me1 = await (await fetch(`${base}/api/me`, { headers: hdr('owner') })).json();
  assert.equal(me1.clinic.address, '12 Park Street, Kolkata 700016');
  assert.equal(me1.clinic.phone, '033-4000-1000');

  // The public website carries the new address (§5.19).
  const site = await websiteService.getPublicSite('clynic-1');
  assert.equal(site.available, true);
  assert.equal(site.site.clinic.address, '12 Park Street, Kolkata 700016');

  // Audited (rule 7).
  const logs = await AuditLog.find({ clinicId: 'org_c1', entityType: 'Clinic', action: 'update' }).lean();
  assert.ok(logs.length >= 1, 'clinic profile update is audited');
  console.log('  ✓ owner edits profile → /me + public site updated, audited');
});

test('non-owner cannot update the clinic profile (RBAC)', async () => {
  const doc = await fetch(`${base}/api/me/clinic`, { method: 'PATCH', headers: hdr('doctor'), body: JSON.stringify({ address: 'hacked' }) });
  assert.equal(doc.status, 403);
  const rec = await fetch(`${base}/api/me/clinic`, { method: 'PATCH', headers: hdr('receptionist'), body: JSON.stringify({ address: 'hacked' }) });
  assert.equal(rec.status, 403);
  const fresh = await Clinic.findOne({ clinicId: 'org_c1' }).lean();
  assert.notEqual(fresh.address, 'hacked');
  console.log('  ✓ doctor/receptionist blocked from editing clinic profile');
});
