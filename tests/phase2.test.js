'use strict';

/**
 * Phase 2 verification — checks (a) plan gating, (c) patient timeline, (d) universal
 * search, (e) hard rules on new collections. Check (b) private files is proven in
 * phase2-reports.test.js. Uses mongodb-memory-server + the real app (DEV_AUTH) for
 * the HTTP plan-gating check, and services directly for the rest.
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.STORAGE_DRIVER = 'local';
const pathmod = require('node:path');
process.env.PRIVATE_UPLOAD_DIR = pathmod.join(require('node:os').tmpdir(), `clinic-p2-${process.pid}`);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('node:fs');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Patient, Prescription, Reminder, AuditLog } = require('../src/models');
const { createApp } = require('../src/app');
const branchService = require('../src/services/branchService');
const doctorService = require('../src/services/doctorService');
const patientService = require('../src/services/patientService');
const appointmentService = require('../src/services/appointmentService');
const prescriptionService = require('../src/services/prescriptionService');
const clinicalNoteService = require('../src/services/clinicalNoteService');
const reportService = require('../src/services/reportService');
const timelineService = require('../src/services/timelineService');
const searchService = require('../src/services/searchService');
const config = require('../src/config/env');

const ctxA = { clinicId: 'org_A', actorId: 'ua', actorRole: 'owner' };
const ctxB = { clinicId: 'org_B', actorId: 'ub', actorRole: 'owner' };
let mongod;
let server;
let base;
let doctorA;

function hdr(clinicId, role = 'owner') {
  return { 'content-type': 'application/json', 'x-dev-clinic-id': clinicId, 'x-dev-role': role, 'x-dev-user-id': `u_${clinicId}` };
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Prescription.init(), Patient.init()]);
  await Clinic.create({ clinicId: 'org_A', name: 'A', slug: 'a2', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_B', name: 'B', slug: 'b2', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_basic', name: 'Basic', slug: 'basic2', subscriptionPlan: 'basic' });
  await branchService.getOrCreatePrimaryBranch(ctxA);
  await branchService.getOrCreatePrimaryBranch(ctxB);
  doctorA = await doctorService.createDoctor(ctxA, 'standard', { name: 'Dr. A', slotDurationMinutes: 30 });

  const app = createApp();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  fs.rmSync(config.storage.localDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
test('(a) plan gating — Basic gets 403 upgrade_required; Standard is allowed', async () => {
  const basic = await fetch(`${base}/api/prescriptions`, { headers: hdr('org_basic') });
  assert.equal(basic.status, 403, 'Basic plan blocked from a Standard feature');
  const body = await basic.json();
  assert.equal(body.error, 'upgrade_required');
  assert.equal(body.feature, 'PRESCRIPTIONS');

  const standard = await fetch(`${base}/api/prescriptions`, { headers: hdr('org_A') });
  assert.equal(standard.status, 200, 'Standard plan allowed');

  // A second gated route behaves the same.
  const reportsBasic = await fetch(`${base}/api/reports`, { headers: hdr('org_basic') });
  assert.equal(reportsBasic.status, 403);

  console.log('  ✓ (a) plan gating: Basic → 403 upgrade_required, Standard → 200 (backend-enforced)');
});

// ---------------------------------------------------------------------------
test('(c) patient timeline aggregates across collections, excludes soft-deleted, date-sorted', async () => {
  const p = await patientService.createPatient(ctxA, { name: 'Timeline Tina', phone: '500', email: 't@x.com' });
  const appt = await appointmentService.book(ctxA, { doctorId: doctorA._id, patientId: p._id, scheduledAt: new Date(Date.now() - 5 * 86400000) });
  const rxKeep = await prescriptionService.create(ctxA, { patientId: p._id, doctorId: doctorA._id, items: [{ drug: 'Paracetamol' }] });
  const rxDeleted = await prescriptionService.create(ctxA, { patientId: p._id, doctorId: doctorA._id, items: [{ drug: 'Ibuprofen' }] });
  await clinicalNoteService.create(ctxA, { patientId: p._id, content: 'Reviewed labs' });
  await reportService.upload(ctxA, { patientId: p._id, type: 'lab', file: { buffer: Buffer.from('x'), originalname: 'r.pdf', mimetype: 'application/pdf', size: 1 } });
  await Reminder.create({ clinicId: 'org_A', patientId: p._id, type: 'appointment_24h', channel: 'email', sendAt: new Date(Date.now() - 6 * 86400000), status: 'sent' });

  // Soft-delete one prescription — it must NOT appear in the timeline.
  await prescriptionService.softDelete(ctxA, rxDeleted._id);

  const items = await timelineService.getTimeline(ctxA, p._id);
  const types = items.map((i) => i.type);
  assert.ok(types.includes('appointment') && types.includes('prescription') && types.includes('note') && types.includes('report') && types.includes('reminder'), 'aggregates all sources');
  assert.ok(!items.some((i) => i.id === String(rxDeleted._id)), 'soft-deleted prescription excluded');
  assert.ok(items.some((i) => i.id === String(rxKeep._id)), 'live prescription present');
  // Sorted by date descending.
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(new Date(items[i - 1].date) >= new Date(items[i].date), 'timeline sorted newest-first');
  }
  void appt;
  console.log('  ✓ (c) timeline merges appts/Rx/notes/reports/reminders, excludes soft-deleted, sorted by date');
});

// ---------------------------------------------------------------------------
test('(d) universal search finds a patient by name, phone, and condition', async () => {
  await patientService.createPatient(ctxA, { name: 'Zarah Khan', phone: '9876500011', medicalHistory: 'chronic asthma since 2019' });

  const byName = await searchService.search(ctxA, 'Zarah');
  assert.ok(byName.patients.some((p) => p.name === 'Zarah Khan'), 'found by name');
  const byPhone = await searchService.search(ctxA, '98765000');
  assert.ok(byPhone.patients.some((p) => p.name === 'Zarah Khan'), 'found by phone');
  const byCondition = await searchService.search(ctxA, 'asthma');
  assert.ok(byCondition.patients.some((p) => p.name === 'Zarah Khan'), 'found by condition (medical history)');

  // Tenant-scoped: clinic B cannot find clinic A's patient.
  const fromB = await searchService.search(ctxB, 'Zarah');
  assert.equal(fromB.patients.length, 0, 'search is tenant-scoped');

  console.log('  ✓ (d) search finds patient by name, phone, and condition — and is tenant-scoped');
});

// ---------------------------------------------------------------------------
test('(e) hard rules on new collections — isolation, soft delete, audit, branchId', async () => {
  const p = await patientService.createPatient(ctxA, { name: 'Rules Ray', phone: '600' });
  const rx = await prescriptionService.create(ctxA, { patientId: p._id, doctorId: doctorA._id, items: [{ drug: 'Amoxicillin', dose: '500mg' }] });

  assert.ok(rx.branchId, 'prescription carries branchId (rule 8)');
  // Audit (rule 7): create recorded.
  const logs = await AuditLog.find({ clinicId: 'org_A', entityType: 'Prescription', entityId: rx._id }).lean();
  assert.ok(logs.some((l) => l.action === 'create'), 'prescription create audited');

  // Tenant isolation (rule 1): clinic B cannot see it.
  const bList = await prescriptionService.list(ctxB, { patientId: p._id });
  assert.equal(bList.length, 0, 'clinic B cannot list clinic A prescriptions');

  // Soft delete (rule 6): excluded from default list, row remains with deletedAt.
  await prescriptionService.softDelete(ctxA, rx._id);
  const aList = await prescriptionService.list(ctxA, { patientId: p._id });
  assert.ok(!aList.some((x) => String(x._id) === String(rx._id)), 'soft-deleted excluded from default query');
  const raw = await Prescription.findById(rx._id).lean();
  assert.ok(raw && raw.deletedAt && raw.deletedBy === 'ua', 'row persists with deletedAt/deletedBy');

  console.log('  ✓ (e) new collections: tenant-isolated, soft-deletable, audited, branch-aware');
});
