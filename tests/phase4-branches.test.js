'use strict';

/**
 * Phase 4 · Step 1 + 2 — plan gating + multi-branch.
 * Proves: MULTI_BRANCH (Premium) is blocked for Standard (403 upgrade_required) and
 * allowed for Premium; branch CRUD works with guards (no removing primary / a branch
 * with active appointments); appointment lists are branch-scoped (and centralized when
 * unfiltered); tenant isolation still holds across clinics.
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Branch, Appointment } = require('../src/models');
const { createApp } = require('../src/app');
const branchService = require('../src/services/branchService');
const appointmentService = require('../src/services/appointmentService');

let mongod;
let server;
let base;

const hdr = (clinicId, role = 'owner', userId = `u_${clinicId}`) => ({ 'content-type': 'application/json', 'x-dev-clinic-id': clinicId, 'x-dev-role': role, 'x-dev-user-id': userId });
const ctx = (clinicId) => ({ clinicId, actorId: `u_${clinicId}`, actorRole: 'owner' });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Branch.init(), Appointment.init()]);
  await Clinic.create({ clinicId: 'org_prem', name: 'Prem', slug: 'prem4', subscriptionPlan: 'premium' });
  await Clinic.create({ clinicId: 'org_std', name: 'Std', slug: 'std4', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_B', name: 'BeeB', slug: 'beeb4', subscriptionPlan: 'premium' });
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

test('(b) plan gating: MULTI_BRANCH blocked for Standard, allowed for Premium', async () => {
  const blocked = await fetch(`${base}/api/branches`, { method: 'POST', headers: hdr('org_std'), body: JSON.stringify({ name: 'Second' }) });
  assert.equal(blocked.status, 403, 'Standard clinic is blocked from multi-branch');
  assert.equal((await blocked.json()).error, 'upgrade_required');

  // Premium: primary auto-provisioned, then a second branch.
  await branchService.getOrCreatePrimaryBranch(ctx('org_prem'));
  const ok = await fetch(`${base}/api/branches`, { method: 'POST', headers: hdr('org_prem'), body: JSON.stringify({ name: 'Salt Lake' }) });
  assert.equal(ok.status, 201, 'Premium clinic can add a branch');
  console.log('  ✓ (b) MULTI_BRANCH gated: Standard 403, Premium 201');
});

test('(c) branch CRUD guards: cannot remove the primary; cannot remove a branch with active appointments', async () => {
  const branches = await branchService.listBranches(ctx('org_prem'));
  const primary = branches.find((b) => b.isPrimary);
  const second = branches.find((b) => !b.isPrimary);

  // Cannot delete the primary branch.
  const delPrimary = await fetch(`${base}/api/branches/${primary._id}`, { method: 'DELETE', headers: hdr('org_prem') });
  assert.equal(delPrimary.status, 400, 'primary branch cannot be removed');

  // A branch with an active appointment cannot be removed.
  await appointmentService; // ensure module loaded
  await new Appointment({ clinicId: 'org_prem', branchId: second._id, patientId: new mongoose.Types.ObjectId(), doctorId: new mongoose.Types.ObjectId(), scheduledAt: new Date(), status: 'booked', patientName: 'X' }).save();
  const delBusy = await fetch(`${base}/api/branches/${second._id}`, { method: 'DELETE', headers: hdr('org_prem') });
  assert.equal(delBusy.status, 409, 'branch with active appointment cannot be removed');
  console.log('  ✓ (c) delete guards enforce primary + active-appointment safety');
});

test('(c) appointments are branch-scoped; unfiltered = centralized across branches', async () => {
  const c = ctx('org_prem');
  const [primary, second] = [
    (await branchService.listBranches(c)).find((b) => b.isPrimary),
    (await branchService.listBranches(c)).find((b) => !b.isPrimary),
  ];
  // One appointment in the primary branch (the 'second' branch already has one from the prior test).
  await new Appointment({ clinicId: 'org_prem', branchId: primary._id, patientId: new mongoose.Types.ObjectId(), doctorId: new mongoose.Types.ObjectId(), scheduledAt: new Date(), status: 'booked', patientName: 'P' }).save();

  const inPrimary = await appointmentService.list(c, { branchId: String(primary._id), from: new Date(Date.now() - 3600e3), to: new Date(Date.now() + 3600e3) });
  const inSecond = await appointmentService.list(c, { branchId: String(second._id), from: new Date(Date.now() - 3600e3), to: new Date(Date.now() + 3600e3) });
  const all = await appointmentService.list(c, { from: new Date(Date.now() - 3600e3), to: new Date(Date.now() + 3600e3) });

  assert.ok(inPrimary.every((a) => String(a.branchId) === String(primary._id)), 'primary filter returns only primary-branch appts');
  assert.ok(inSecond.every((a) => String(a.branchId) === String(second._id)), 'second filter returns only second-branch appts');
  assert.ok(all.length >= inPrimary.length + inSecond.length, 'unfiltered list spans all branches (centralized)');
  console.log('  ✓ (c) branch filter scopes; unfiltered is the centralized owner view');
});

test('(c) tenant isolation: clinic B cannot see clinic A branches', async () => {
  await branchService.getOrCreatePrimaryBranch(ctx('org_B'));
  const res = await fetch(`${base}/api/branches`, { headers: hdr('org_B') });
  const items = (await res.json()).items;
  assert.ok(items.every((b) => b.clinicId === 'org_B'), 'clinic B sees only its own branches');
  const aBranches = await branchService.listBranches(ctx('org_prem'));
  assert.ok(!items.some((b) => aBranches.some((ab) => String(ab._id) === String(b._id))), 'no clinic-A branch leaks to clinic B');
  console.log('  ✓ (c) branch listing is tenant-isolated');
});
