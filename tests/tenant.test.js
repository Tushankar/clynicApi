'use strict';

/**
 * Phase 0 verification — proves the three required checks against a real (in-memory)
 * MongoDB, exercising the SAME tenant data layer the controllers use:
 *
 *   (a) Tenant isolation — a user in clinic A can never read clinic B's patients.
 *   (b) Soft delete      — a deleted patient leaves default queries but stays in the
 *                          DB with deletedAt/deletedBy set.
 *   (c) Audit log        — create/update/delete each write an auditLogs entry.
 *
 * Run: npm test   (uses node --test; spins up mongodb-memory-server)
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Patient, AuditLog, Counter } = require('../src/models');
const { tenantRepo } = require('../src/lib/TenantRepository');
const patientService = require('../src/services/patientService');

let mongod;

const ctxA = { clinicId: 'org_clinicA', actorId: 'user_a1', actorRole: 'owner' };
const ctxB = { clinicId: 'org_clinicB', actorId: 'user_b1', actorRole: 'owner' };

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Patient.init(); // ensure unique/text indexes are built
  await AuditLog.init();
});

after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Patient.deleteMany({});
  await AuditLog.deleteMany({});
  await Counter.deleteMany({});
});

// ---------------------------------------------------------------------------
test('(a) tenant isolation — clinic A cannot read clinic B patients', async () => {
  const repoA = tenantRepo(Patient, ctxA);
  const repoB = tenantRepo(Patient, ctxB);

  const pA = await repoA.create({ name: 'Alice (Clinic A)', phone: '111', patientCode: 'A001' });
  const pB = await repoB.create({ name: 'Bob (Clinic B)', phone: '222', patientCode: 'B001' });

  // A only sees its own patient
  const aList = await repoA.find();
  assert.equal(aList.length, 1, 'clinic A should see exactly 1 patient');
  assert.equal(aList[0].name, 'Alice (Clinic A)');

  // A cannot fetch B's patient by id
  const leaked = await repoA.findById(pB._id);
  assert.equal(leaked, null, 'clinic A must NOT retrieve clinic B patient by id');

  // B cannot fetch A's patient by id
  assert.equal(await repoB.findById(pA._id), null, 'clinic B must NOT retrieve clinic A patient by id');

  // Cross-tenant injection: passing another clinicId on create is ignored.
  const injected = await repoA.create({ name: 'Injection', clinicId: 'org_clinicB', patientCode: 'A002' });
  assert.equal(injected.clinicId, 'org_clinicA', 'create must force the request clinicId');

  console.log('  ✓ (a) tenant isolation: A sees only A; cross-tenant id reads return null; clinicId injection blocked');
});

// ---------------------------------------------------------------------------
test('(b) soft delete — leaves default queries, remains in DB with deletedAt/deletedBy', async () => {
  const repoA = tenantRepo(Patient, ctxA);
  const p = await repoA.create({ name: 'To Be Deleted', phone: '333', patientCode: 'A010' });

  await repoA.softDeleteById(p._id);

  // Gone from default queries
  const visible = await repoA.find();
  assert.equal(visible.length, 0, 'soft-deleted patient must not appear in default queries');
  assert.equal(await repoA.findById(p._id), null, 'findById excludes soft-deleted by default');
  assert.equal(await repoA.count(), 0, 'count excludes soft-deleted by default');

  // Still visible with includeDeleted
  const withDeleted = await repoA.find({}, { includeDeleted: true });
  assert.equal(withDeleted.length, 1, 'includeDeleted must reveal the soft-deleted patient');

  // Still physically in the DB (raw query bypassing the repo)
  const raw = await Patient.findById(p._id).lean();
  assert.ok(raw, 'document must still exist physically in the collection');
  assert.ok(raw.deletedAt instanceof Date, 'deletedAt must be set to a Date');
  assert.equal(raw.deletedBy, 'user_a1', 'deletedBy must be the actor id');

  console.log('  ✓ (b) soft delete: hidden from default queries, still in DB with deletedAt/deletedBy set');
});

// ---------------------------------------------------------------------------
test('(c) audit log — create/update/delete each write an auditLogs entry', async () => {
  const repoA = tenantRepo(Patient, ctxA);

  const p = await repoA.create({ name: 'Audited Patient', phone: '444', patientCode: 'A020' });
  await repoA.updateById(p._id, { name: 'Audited Patient (edited)' });
  await repoA.softDeleteById(p._id);

  const logs = await AuditLog.find({ clinicId: ctxA.clinicId, entityId: p._id }).sort({ createdAt: 1 }).lean();
  const actions = logs.map((l) => l.action);

  assert.deepEqual(actions, ['create', 'update', 'delete'], 'expected create, update, delete audit entries');

  // Audit content sanity
  for (const l of logs) {
    assert.equal(l.clinicId, ctxA.clinicId, 'audit entry must carry clinicId');
    assert.equal(l.entityType, 'Patient', 'audit entry must record entityType');
    assert.equal(l.actorId, 'user_a1', 'audit entry must record actor');
    assert.equal(l.actorRole, 'owner', 'audit entry must record actor role');
  }
  const update = logs.find((l) => l.action === 'update');
  assert.equal(update.before.name, 'Audited Patient', 'update audit must keep the before snapshot');
  assert.equal(update.after.name, 'Audited Patient (edited)', 'update audit must keep the after snapshot');

  // Audit logs are scoped too: clinic B sees none of A's audit entries.
  const bLogs = await AuditLog.find({ clinicId: ctxB.clinicId, entityId: p._id });
  assert.equal(bLogs.length, 0, 'audit entries must be clinic-scoped');

  console.log('  ✓ (c) audit log: create/update/delete recorded with actor, role, before/after, clinic-scoped');
});

// ---------------------------------------------------------------------------
test('guard — tenantRepo without a clinicId throws (no accidental full-collection scan)', async () => {
  assert.throws(() => tenantRepo(Patient, { actorId: 'x' }), /clinicId/, 'must refuse a context without clinicId');
  console.log('  ✓ guard: missing clinicId context is rejected (hard rule 1)');
});

// ---------------------------------------------------------------------------
test('end-to-end via patientService — auto patientCode + isolation + soft delete + audit', async () => {
  // create with NO patientCode -> service auto-generates a per-clinic code
  const created = await patientService.createPatient(ctxA, { name: 'E2E Patient', phone: '555' });
  assert.match(created.patientCode, /^P\d{5}$/, 'service must auto-generate a per-clinic patientCode');

  // clinic B cannot see it through the service either
  const bView = await patientService.listPatients(ctxB);
  assert.equal(bView.total, 0, 'clinic B must not see clinic A patients via the service');

  // update + soft delete through the service
  await patientService.updatePatient(ctxA, created._id, { name: 'E2E Patient (edited)' });
  await patientService.softDeletePatient(ctxA, created._id);

  const aView = await patientService.listPatients(ctxA);
  assert.equal(aView.total, 0, 'soft-deleted patient gone from default service listing');

  // soft-deleted record still physically present
  const raw = await Patient.findById(created._id).lean();
  assert.ok(raw && raw.deletedAt && raw.deletedBy === 'user_a1', 'record persists with deletedAt/deletedBy');

  // full audit trail recorded
  const actions = (await AuditLog.find({ entityId: created._id }).sort({ createdAt: 1 }).lean()).map((l) => l.action);
  assert.deepEqual(actions, ['create', 'update', 'delete'], 'service path writes full audit trail');

  console.log('  ✓ e2e: patientService auto-codes, scopes, soft-deletes and audits via the tenant layer');
});

// ---------------------------------------------------------------------------
test('no-op update writes NO audit entry; a real update writes exactly one', async () => {
  const repoA = tenantRepo(Patient, ctxA);
  const p = await repoA.create({ name: 'NoOp', phone: '777', patientCode: 'A030' });

  await repoA.updateById(p._id, {}); // empty -> no change
  await repoA.updateById(p._id, { name: 'NoOp' }); // same value -> no change
  let updates = await AuditLog.find({ entityId: p._id, action: 'update' });
  assert.equal(updates.length, 0, 'no-op updates must not write phantom audit entries');

  await repoA.updateById(p._id, { name: 'Changed' }); // real change
  updates = await AuditLog.find({ entityId: p._id, action: 'update' });
  assert.equal(updates.length, 1, 'a real update writes exactly one audit entry');

  console.log('  ✓ no-op update audit suppression: empty/same-value updates leave a clean audit trail');
});

// ---------------------------------------------------------------------------
test('patientService assigns distinct, sequential, per-clinic patient codes (atomic counter)', async () => {
  const a = await patientService.createPatient(ctxA, { name: 'Seq One' });
  const b = await patientService.createPatient(ctxA, { name: 'Seq Two' });
  assert.equal(a.patientCode, 'P00001');
  assert.equal(b.patientCode, 'P00002', 'codes increment monotonically per clinic');

  // Concurrent creates must each get a distinct code (no count()+1 race).
  const burst = await Promise.all(
    Array.from({ length: 10 }, (_, i) => patientService.createPatient(ctxA, { name: `Burst ${i}` }))
  );
  const codes = burst.map((p) => p.patientCode);
  assert.equal(new Set(codes).size, codes.length, 'concurrent creates must yield unique codes');

  // Clinic B has its own independent sequence.
  const c = await patientService.createPatient(ctxB, { name: 'B One' });
  assert.equal(c.patientCode, 'P00001', 'each clinic has an independent code sequence');

  console.log('  ✓ atomic patientCode counter: sequential, race-safe under concurrency, per-clinic isolated');
});
