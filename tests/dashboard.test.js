'use strict';

/**
 * Dashboard summary endpoint (§5 home). Proves the aggregation pipelines actually run
 * end-to-end and stay clinic-scoped: KPIs (+sparklines), weekly series, demographics,
 * doctor availability, live queue, activity feed, and AI suggestions.
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Doctor, Patient } = require('../src/models');
const { createApp } = require('../src/app');

let mongod;
let server;
let base;
const hdr = (clinicId, role = 'owner') => ({ 'content-type': 'application/json', 'x-dev-clinic-id': clinicId, 'x-dev-role': role, 'x-dev-user-id': `u_${clinicId}` });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Clinic.init(), Doctor.init(), Patient.init()]);

  await Clinic.create({ clinicId: 'org_dash', name: 'Dash Clinic', slug: 'dash', subscriptionPlan: 'premium', phone: '111', address: 'Salt Lake, Kolkata' });
  await new Doctor({ clinicId: 'org_dash', name: 'Dr Anjan Sen', specialization: 'Cardiology', isActive: true }).save();
  await new Patient({ clinicId: 'org_dash', patientCode: 'PT-0001', name: 'P One', gender: 'male', phone: '1' }).save();
  await new Patient({ clinicId: 'org_dash', patientCode: 'PT-0002', name: 'P Two', gender: 'female', phone: '2' }).save();
  await new Patient({ clinicId: 'org_dash', patientCode: 'PT-0003', name: 'P Three', gender: 'female', phone: '3' }).save();
  // A separate clinic that must NEVER appear in org_dash's dashboard.
  await Clinic.create({ clinicId: 'org_other', name: 'Other Clinic', slug: 'other', subscriptionPlan: 'basic' });
  await new Doctor({ clinicId: 'org_other', name: 'Dr Bleed', specialization: 'X', isActive: true }).save();
  await new Patient({ clinicId: 'org_other', patientCode: 'PT-9001', name: 'Bleed Patient', gender: 'male', phone: '9' }).save();

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

test('GET /dashboard/summary returns the full, well-formed payload', async () => {
  const res = await fetch(`${base}/api/dashboard/summary`, { headers: hdr('org_dash') });
  assert.equal(res.status, 200);
  const b = await res.json();

  // KPIs — all five, each with a 7-point sparkline + trend fields.
  for (const key of ['patients', 'appointments', 'revenue', 'avgWait', 'noShows']) {
    assert.ok(b.kpis[key], `kpi ${key} present`);
    assert.equal(b.kpis[key].spark.length, 7, `${key} sparkline has 7 points`);
    assert.ok(['up', 'down', 'flat'].includes(b.kpis[key].dir));
  }

  // Weekly series — 7 aligned points each.
  assert.equal(b.weekly.revenue.length, 7);
  assert.equal(b.weekly.appointments.length, 7);

  // Demographics from the 3 seeded patients (1 male, 2 female).
  assert.equal(b.demographics.total, 3);
  assert.equal(b.demographics.male, 1);
  assert.equal(b.demographics.female, 2);

  // Doctor availability + queue + activity present.
  assert.deepEqual(b.doctors.map((d) => d.name), ['Dr Anjan Sen']);
  assert.ok(b.queue && b.queue.counts);
  assert.ok(Array.isArray(b.activity));
  assert.ok(Array.isArray(b.ai.suggestions));
  console.log('  ✓ dashboard summary payload is complete and well-formed');
});

test('dashboard is strictly clinic-scoped (no data bleed)', async () => {
  const b = await (await fetch(`${base}/api/dashboard/summary`, { headers: hdr('org_dash') })).json();
  const blob = JSON.stringify(b);
  assert.ok(!blob.includes('Dr Bleed'), 'another clinic\'s doctor never appears');
  assert.ok(!blob.includes('Bleed Patient'), 'another clinic\'s patient never appears');
  assert.equal(b.demographics.total, 3, 'demographics count only this clinic\'s patients');
  console.log('  ✓ dashboard summary is fully isolated to the requesting clinic');
});
