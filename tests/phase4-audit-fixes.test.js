'use strict';

/**
 * Phase 4 adversarial-audit regressions. Locks in the confirmed fixes:
 *   - a FLAGGED AI draft cannot be approved verbatim — the doctor must edit it (rule 2).
 *   - website content sanitization drops non-https map URLs + non-http(s) gallery URLs (SSRF/XSS).
 *   - completing a visit writes a Patient audit entry (rule 7).
 *   - Payment is soft-deletable (rule 6, financial record).
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';
process.env.AI_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Patient, AiDraft, ClinicalNote, Appointment, AuditLog, Payment } = require('../src/models');
const aiService = require('../src/services/aiService');
const websiteService = require('../src/services/websiteService');
const appointmentService = require('../src/services/appointmentService');
const { AI_DISCLAIMER } = require('../src/lib/ai/guard');

let mongod;
const ctx = (clinicId, role = 'doctor') => ({ clinicId, actorId: `u_${clinicId}`, actorRole: role });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Clinic.create({ clinicId: 'org_fix', name: 'Fix Clinic', slug: 'fixc', subscriptionPlan: 'premium' });
});

after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test('a FLAGGED AI draft cannot be approved without a doctor edit (rule 2)', async () => {
  const c = ctx('org_fix');
  const p = await new Patient({ clinicId: 'org_fix', patientCode: 'PF1', name: 'Q' }).save();
  const draft = await new AiDraft({ clinicId: 'org_fix', kind: 'visit_summary', patientId: p._id, content: 'You likely have diabetes.', disclaimer: AI_DISCLAIMER, flagged: true, status: 'pending_review' }).save();

  // Approve without an edit → rejected; nothing saved.
  await assert.rejects(() => aiService.approveDraft(c, draft._id, {}), (e) => e.statusCode === 400);
  assert.equal(await ClinicalNote.countDocuments({ clinicId: 'org_fix', patientId: p._id }), 0, 'flagged AI text not saved');

  // Approve WITH a doctor edit → saved (doctor is the author).
  const ok = await aiService.approveDraft(c, draft._id, { editedContent: 'Reviewed: stable, no concerns.' });
  assert.ok(ok.noteId);
  const note = await ClinicalNote.findById(ok.noteId).lean();
  assert.equal(note.content, 'Reviewed: stable, no concerns.');
  console.log('  ✓ flagged draft blocked until doctor edits it');
});

test('website sanitization drops unsafe map + gallery URLs (SSRF/XSS)', async () => {
  const c = ctx('org_fix', 'owner');
  const clean = await websiteService.updateContent(c, {
    published: true,
    gallery: ['https://cdn.example/ok.jpg', 'javascript:alert(1)', 'http://x/img.png', 'data:text/html,evil'],
    contact: { mapUrl: 'javascript:alert(1)' },
  });
  assert.deepEqual(clean.gallery, ['https://cdn.example/ok.jpg', 'http://x/img.png'], 'only http(s) images kept');
  assert.equal(clean.contact.mapUrl, '', 'non-https map URL dropped');

  const clean2 = await websiteService.updateContent(c, { contact: { mapUrl: 'https://www.google.com/maps/embed?pb=xyz' } });
  assert.match(clean2.contact.mapUrl, /^https:\/\//, 'valid https map URL kept');
  console.log('  ✓ website sanitizer blocks javascript:/data: and non-https URLs');
});

test('completing a visit writes a Patient audit entry (rule 7)', async () => {
  const c = ctx('org_fix');
  const p = await new Patient({ clinicId: 'org_fix', patientCode: 'PF2', name: 'V', visitCount: 0 }).save();
  const appt = await new Appointment({ clinicId: 'org_fix', branchId: new mongoose.Types.ObjectId(), patientId: p._id, doctorId: new mongoose.Types.ObjectId(), scheduledAt: new Date(), status: 'in_consultation', patientName: 'V' }).save();

  await appointmentService.transition(c, appt._id, 'completed');
  const logs = await AuditLog.find({ clinicId: 'org_fix', entityType: 'Patient', entityId: p._id, action: 'update' }).lean();
  assert.ok(logs.some((l) => l.after && l.after.visitCount === 1), 'visit-tracking update is audited with the new count');
  console.log('  ✓ visit completion writes a Patient audit entry');
});

test('Payment is soft-deletable (rule 6 — financial record)', async () => {
  assert.ok(Payment.schema.path('deletedAt'), 'Payment has deletedAt (soft-deletable)');
  assert.ok(Payment.schema.path('deletedBy'), 'Payment has deletedBy');
  console.log('  ✓ Payment is soft-deletable like Invoice');
});
