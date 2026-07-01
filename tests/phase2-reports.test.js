'use strict';

/**
 * Step 6 proof — private medical files (HARD RULE 3).
 * Proves: files are stored privately (opaque key, no public URL), retrievable only
 * via a short-lived signed token, every view writes a "report viewed" audit, signed
 * tokens are tamper/expiry/cross-tenant proof, and soft delete retains the bytes
 * while blocking new access.
 */
process.env.NODE_ENV = 'development';
process.env.STORAGE_DRIVER = 'local';
const path = require('node:path');
process.env.PRIVATE_UPLOAD_DIR = path.join(require('node:os').tmpdir(), `clinic-priv-${process.pid}`);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Report, AuditLog } = require('../src/models');
const patientService = require('../src/services/patientService');
const reportService = require('../src/services/reportService');
const signing = require('../src/lib/signing');
const config = require('../src/config/env');

const ctxA = { clinicId: 'org_A', actorId: 'user_a', actorRole: 'owner' };
const ctxB = { clinicId: 'org_B', actorId: 'user_b', actorRole: 'owner' };
let mongod;
let patientA;
const FILE = Buffer.from('%PDF-1.4 fake blood report bytes');

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Report.init();
  await Clinic.create({ clinicId: 'org_A', name: 'A Clinic', slug: 'a-clinic', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_B', name: 'B Clinic', slug: 'b-clinic', subscriptionPlan: 'standard' });
  patientA = await patientService.createPatient(ctxA, { name: 'Report Patient', phone: '111' });
});

after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  fs.rmSync(config.storage.localDir, { recursive: true, force: true });
});

test('upload stores privately (opaque key, no public URL) + branchId + audit', async () => {
  const report = await reportService.upload(ctxA, {
    patientId: patientA._id,
    type: 'lab',
    file: { buffer: FILE, originalname: 'blood test.pdf', mimetype: 'application/pdf', size: FILE.length },
  });

  assert.equal(report.storageDriver, 'local');
  assert.ok(report.storageKey && !report.storageKey.startsWith('http'), 'storageKey is an opaque key, not a URL');
  assert.ok(report.branchId, 'report carries branchId (hard rule 8)');
  // No public URL field anywhere on the document.
  const raw = await Report.findById(report._id).lean();
  assert.equal(raw.fileUrl, undefined);
  assert.ok(!JSON.stringify(raw).includes('http'), 'no http(s) URL persisted on the report');

  // File is physically under the PRIVATE dir (not a web-served path) and matches bytes.
  const onDisk = path.join(config.storage.localDir, 'org_A', report.storageKey);
  assert.ok(fs.existsSync(onDisk), 'bytes stored under the private upload dir');
  assert.deepEqual(fs.readFileSync(onDisk), FILE);

  console.log('  ✓ stored privately: opaque key, no public URL, bytes under private dir, branchId set');
});

test('access is signed-URL only, and viewing writes a "report viewed" audit', async () => {
  const report = (await reportService.list(ctxA, { patientId: patientA._id }))[0];
  const before = await AuditLog.countDocuments({ clinicId: 'org_A', entityType: 'Report', action: 'read' });

  const signed = await reportService.getSignedUrl(ctxA, report._id);
  assert.match(signed.path, /^\/api\/files\/report\/.+\?t=/, 'returns a signed file path, not a public URL');
  const token = decodeURIComponent(signed.path.split('?t=')[1]);

  const { report: streamed, stream } = await reportService.streamReport(token, report._id);
  assert.equal(String(streamed._id), String(report._id));
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  assert.deepEqual(Buffer.concat(chunks), FILE, 'signed token streams the real bytes');

  const after = await AuditLog.countDocuments({ clinicId: 'org_A', entityType: 'Report', action: 'read' });
  assert.equal(after, before + 1, 'a "report viewed" (read) audit entry was written');

  console.log('  ✓ signed-URL-only access streams bytes + writes a "report viewed" audit');
});

test('tampered / wrong-report / cross-tenant tokens are rejected', async () => {
  const report = (await reportService.list(ctxA, { patientId: patientA._id }))[0];
  const { path: p } = await reportService.getSignedUrl(ctxA, report._id);
  const token = decodeURIComponent(p.split('?t=')[1]);

  // Tampered token → rejected.
  await assert.rejects(() => reportService.streamReport(`${token}x`, report._id), /Invalid or expired/);
  // Valid token but wrong report id in the URL → rejected.
  await assert.rejects(() => reportService.streamReport(token, '64b000000000000000000000'), /does not match/);
  // Expired token → rejected.
  const expired = signing.sign({ rid: String(report._id), cid: 'org_A', aid: 'user_a', rl: 'owner', exp: Date.now() - 1000 });
  await assert.rejects(() => reportService.streamReport(expired, report._id), /Invalid or expired/);
  // Cross-tenant: a token claiming clinic B can't reach clinic A's report.
  const crossTenant = signing.sign({ rid: String(report._id), cid: 'org_B', aid: 'user_b', rl: 'owner', exp: Date.now() + 60000 });
  await assert.rejects(() => reportService.streamReport(crossTenant, report._id), /not found/i);

  console.log('  ✓ tampered, wrong-report, expired, and cross-tenant tokens all rejected');
});

test('[fix] uploaded filename is sanitized — no control chars persisted', async () => {
  const report = await reportService.upload(ctxA, {
    patientId: patientA._id,
    type: 'lab',
    file: { buffer: Buffer.from('x'), originalname: 'evil\r\nSet-Cookie: a=b.pdf', mimetype: 'application/pdf', size: 1 },
  });
  assert.ok(!/[\r\n"]/.test(report.originalName), 'CR/LF/quotes stripped from stored originalName');
  const signed = await reportService.getSignedUrl(ctxA, report._id);
  const { report: s } = await reportService.streamReport(decodeURIComponent(signed.path.split('?t=')[1]), report._id);
  assert.ok(s, 'still streamable with a clean name');
  console.log('  ✓ [fix] upload filename sanitized (no header-injection vector)');
});

test('[fix] missing bytes → 404 and NO phantom "report viewed" audit', async () => {
  const report = await reportService.upload(ctxA, {
    patientId: patientA._id,
    type: 'lab',
    file: { buffer: Buffer.from('y'), originalname: 'gone.pdf', mimetype: 'application/pdf', size: 1 },
  });
  fs.unlinkSync(path.join(config.storage.localDir, 'org_A', report.storageKey)); // simulate lost bytes

  const before = await AuditLog.countDocuments({ clinicId: 'org_A', entityType: 'Report', action: 'read' });
  const signed = await reportService.getSignedUrl(ctxA, report._id);
  await assert.rejects(() => reportService.streamReport(decodeURIComponent(signed.path.split('?t=')[1]), report._id), /unavailable|not found/i);
  const after = await AuditLog.countDocuments({ clinicId: 'org_A', entityType: 'Report', action: 'read' });
  assert.equal(after, before, 'no read audit written when no bytes are delivered');
  console.log('  ✓ [fix] undeliverable file → 404, no phantom view audit');
});

test('soft delete retains bytes but blocks new signed URLs', async () => {
  // Target the original upload explicitly (later tests add reports / delete bytes).
  const report = (await reportService.list(ctxA, { patientId: patientA._id })).find((r) => r.originalName === 'blood_test.pdf');
  const onDisk = path.join(config.storage.localDir, 'org_A', report.storageKey);

  await reportService.softDelete(ctxA, report._id);
  const list = await reportService.list(ctxA, { patientId: patientA._id });
  assert.ok(!list.some((r) => String(r._id) === String(report._id)), 'soft-deleted report excluded from listing');
  await assert.rejects(() => reportService.getSignedUrl(ctxA, report._id), /not found/i, 'no new signed URL for a deleted report');
  assert.ok(fs.existsSync(onDisk), 'bytes retained on disk (soft delete, not hard delete)');

  console.log('  ✓ soft delete: hidden + no new links, bytes retained (Rule 6)');
});
