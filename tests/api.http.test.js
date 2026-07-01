'use strict';

/**
 * HTTP-level integration test — boots the REAL Express app and hits the real
 * routes, proving the middleware stack end to end:
 *   - auth context (clinicId/role/userId) via the dev header bypass
 *   - RBAC (requireRole) returns 403 for the wrong role
 *   - tenant isolation at the route layer (clinic B can't list clinic A patients)
 *   - plan introspection (GET /me/plan)
 *
 * Uses DEV_AUTH=true so no Clerk session is needed; identity comes from x-dev-* headers.
 */

// Must be set BEFORE requiring config/env (node --test runs each file in its own process).
process.env.DEV_AUTH = 'true';
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { connectDB, disconnectDB } = require('../src/config/db');
const { createApp } = require('../src/app');
const { Clinic } = require('../src/models');

let mongod;
let server;
let base;

function hdrs(clinicId, role, userId = 'u_' + role) {
  return {
    'content-type': 'application/json',
    'x-dev-clinic-id': clinicId,
    'x-dev-role': role,
    'x-dev-user-id': userId,
  };
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
  // Seed a clinic doc so /me/plan resolves a real plan.
  await Clinic.create({ clinicId: 'org_A', name: 'Clinic A', subscriptionPlan: 'standard' });
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await disconnectDB();
  if (mongod) await mongod.stop();
});

test('GET /api/health is public', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('protected route without identity -> 401', async () => {
  const res = await fetch(`${base}/api/patients`);
  assert.equal(res.status, 401);
});

test('RBAC — doctor cannot create a patient (403), receptionist can (201)', async () => {
  const asDoctor = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: hdrs('org_A', 'doctor'),
    body: JSON.stringify({ name: 'Should Fail' }),
  });
  assert.equal(asDoctor.status, 403, 'doctor must be denied create');

  const asReception = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: hdrs('org_A', 'receptionist'),
    body: JSON.stringify({ name: 'Created By Reception', phone: '900' }),
  });
  assert.equal(asReception.status, 201, 'receptionist must be allowed to create');
  const created = await asReception.json();
  assert.match(created.patientCode, /^P\d{5}$/);
});

test('tenant isolation at the HTTP layer — clinic B cannot see clinic A patients', async () => {
  // create in clinic A
  await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: hdrs('org_A', 'owner'),
    body: JSON.stringify({ name: 'A-only Patient', phone: '901' }),
  });
  // list as clinic B
  const bList = await (await fetch(`${base}/api/patients`, { headers: hdrs('org_B', 'owner') })).json();
  assert.equal(bList.total, 0, 'clinic B must see zero clinic A patients');
});

test('RBAC — only owner can soft-delete', async () => {
  const created = await (
    await fetch(`${base}/api/patients`, {
      method: 'POST',
      headers: hdrs('org_A', 'owner'),
      body: JSON.stringify({ name: 'Delete Me', phone: '902' }),
    })
  ).json();

  const asReception = await fetch(`${base}/api/patients/${created._id}`, {
    method: 'DELETE',
    headers: hdrs('org_A', 'receptionist'),
  });
  assert.equal(asReception.status, 403, 'receptionist must not delete');

  const asOwner = await fetch(`${base}/api/patients/${created._id}`, {
    method: 'DELETE',
    headers: hdrs('org_A', 'owner'),
  });
  assert.equal(asOwner.status, 200, 'owner deletes (soft)');

  // gone from default listing
  const list = await (await fetch(`${base}/api/patients`, { headers: hdrs('org_A', 'owner') })).json();
  assert.ok(!list.items.some((p) => p._id === created._id), 'soft-deleted patient not in default listing');
});

test('includeDeleted is owner-only (RBAC + soft delete)', async () => {
  const created = await (
    await fetch(`${base}/api/patients`, {
      method: 'POST',
      headers: hdrs('org_A', 'owner'),
      body: JSON.stringify({ name: 'Deleted View', phone: '903' }),
    })
  ).json();
  await fetch(`${base}/api/patients/${created._id}`, { method: 'DELETE', headers: hdrs('org_A', 'owner') });

  // Non-owner requesting soft-deleted records -> 403
  const recep = await fetch(`${base}/api/patients?includeDeleted=true`, { headers: hdrs('org_A', 'receptionist') });
  assert.equal(recep.status, 403, 'receptionist must be denied includeDeleted');

  // Owner can view soft-deleted records
  const owner = await fetch(`${base}/api/patients?includeDeleted=true`, { headers: hdrs('org_A', 'owner') });
  assert.equal(owner.status, 200);
  const body = await owner.json();
  assert.ok(body.items.some((p) => p._id === created._id), 'owner sees the soft-deleted patient with includeDeleted');
});

test('GET /api/me/plan resolves the clinic plan + feature flags', async () => {
  const res = await fetch(`${base}/api/me/plan`, { headers: hdrs('org_A', 'owner') });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan, 'standard');
  assert.equal(body.features.PRESCRIPTIONS, true, 'standard includes PRESCRIPTIONS');
  assert.equal(body.features.AI_FEATURES, false, 'standard excludes premium AI_FEATURES');
});
