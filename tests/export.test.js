'use strict';

/**
 * Data export (§5.23) — proves the broadened "export my data" now includes the actual MEDICAL
 * RECORD (prescriptions, clinical notes, lab requests) plus a report file manifest, which the
 * previous export silently excluded, and that it stays tenant-scoped.
 */
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Patient, Prescription, ClinicalNote, LabRequest, Report } = require('../src/models');
const { tenantRepo } = require('../src/lib/TenantRepository');
const exportService = require('../src/services/exportService');

const ctx = { clinicId: 'org_exp', actorId: 'u1', actorRole: 'owner' };
let mongod;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test('export now includes the full medical record (prescriptions, notes, labs, report manifest)', async () => {
  const p = await tenantRepo(Patient, ctx).create({ name: 'Export Pat', patientCode: 'EP1', phone: '900' });
  await tenantRepo(Prescription, ctx).create({ patientId: p._id, doctorId: new mongoose.Types.ObjectId(), patientName: 'Export Pat', doctorName: 'Dr X', diagnosis: 'Flu', items: [{ drug: 'Paracetamol', dose: '500mg', frequency: '1-0-1', duration: '5d' }] });
  await tenantRepo(ClinicalNote, ctx).create({ patientId: p._id, doctorName: 'Dr X', content: 'Patient stable' });
  await tenantRepo(LabRequest, ctx).create({ patientId: p._id, patientName: 'Export Pat', tests: ['CBC', 'LFT'], status: 'requested' });
  await tenantRepo(Report, ctx).create({ patientId: p._id, type: 'lab', title: 'CBC result', storageDriver: 'local', storageKey: 'k/abc', originalName: 'cbc.pdf', mimeType: 'application/pdf', size: 1234 });

  for (const entity of ['prescriptions', 'clinical_notes', 'lab_requests', 'reports']) {
    assert.ok(exportService.ENTITIES.includes(entity), `${entity} is now an exportable entity`);
  }

  const rx = await exportService.exportCsv(ctx, 'prescriptions');
  assert.match(rx.csv, /Paracetamol 500mg 1-0-1 5d/);
  assert.match(rx.csv, /Flu/);

  const notes = await exportService.exportCsv(ctx, 'clinical_notes');
  assert.match(notes.csv, /Patient stable/);

  const labs = await exportService.exportCsv(ctx, 'lab_requests');
  assert.match(labs.csv, /CBC; LFT/);

  const reports = await exportService.exportCsv(ctx, 'reports');
  assert.match(reports.csv, /cbc\.pdf/);
  assert.match(reports.csv, /k\/abc/); // storage key present so no file is silently left behind

  console.log('  ✓ export includes prescriptions, clinical notes, lab requests, and a report file manifest');
});

test('export stays tenant-scoped and rejects unknown entities', async () => {
  const other = { clinicId: 'org_other', actorId: 'u2', actorRole: 'owner' };
  const op = await tenantRepo(Patient, other).create({ name: 'Other Pat', patientCode: 'OP1' });
  await tenantRepo(Prescription, other).create({ patientId: op._id, doctorId: new mongoose.Types.ObjectId(), patientName: 'Other Pat', items: [{ drug: 'Secret' }] });

  const rx = await exportService.exportCsv(ctx, 'prescriptions');
  assert.ok(!rx.csv.includes('Other Pat') && !rx.csv.includes('Secret'), 'no cross-clinic bleed');
  await assert.rejects(() => exportService.exportCsv(ctx, 'bogus'), /Unknown export/);
  console.log('  ✓ export is clinic-scoped; unknown entity rejected');
});
