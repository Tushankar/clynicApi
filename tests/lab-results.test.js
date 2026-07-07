'use strict';

/**
 * Lab result capture — proves the order → collect → RESULT loop now closes: a lab order can store
 * structured result values + an interpretation note and auto-complete (previously status could reach
 * 'completed' with nowhere to record what came back).
 */
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Patient } = require('../src/models');
const { tenantRepo } = require('../src/lib/TenantRepository');
const labService = require('../src/services/labRequestService');

const ctx = { clinicId: 'org_lab', actorId: 'dr1', actorRole: 'doctor' };
let mongod;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test('lab results capture: structured rows + notes, auto-complete, blank rows dropped, flags sanitized', async () => {
  const p = await tenantRepo(Patient, ctx).create({ name: 'Lab Pat', patientCode: 'LP1' });
  const lab = await labService.create(ctx, { patientId: p._id, tests: ['CBC', 'Glucose'] });
  assert.equal(lab.status, 'requested');
  assert.deepEqual(lab.results, [], 'no results field before this change had anywhere to go');

  const done = await labService.recordResults(ctx, lab._id, {
    results: [
      { test: 'CBC', value: '12.5', unit: 'g/dL', refRange: '13-17', flag: 'low' },
      { test: 'Glucose', value: '95', unit: 'mg/dL', refRange: '70-100', flag: 'normal' },
      { test: 'Glucose', value: '' }, // blank value → dropped (UI sends a row per ordered test)
    ],
    resultNotes: 'Mild anaemia, review in 2 weeks',
  });
  assert.equal(done.status, 'completed', 'recording results completes the order');
  assert.equal(done.results.length, 2, 'blank-value rows are dropped');
  assert.equal(done.results[0].flag, 'low');
  assert.equal(done.resultNotes, 'Mild anaemia, review in 2 weeks');
  assert.ok(done.resultedAt, 'resultedAt stamped');
  assert.equal(done.resultedBy, 'dr1');

  // Invalid flag → coerced to '' (schema enum-safe); complete:false leaves status alone.
  const d2 = await labService.recordResults(ctx, lab._id, { results: [{ test: 'CBC', value: '13', flag: 'bogus' }], complete: false });
  assert.equal(d2.results[0].flag, '', 'unknown flag is sanitized to empty');
  assert.equal(d2.results.length, 1);

  console.log('  ✓ lab results captured against the order (values + notes), auto-completes, flags sanitized');
});
