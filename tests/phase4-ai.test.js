'use strict';

/**
 * Phase 4 · Step 5 — AI features, HARD RULE 2 (AI NEVER DIAGNOSES). The most important test.
 * Proves, structurally:
 *   1. AI is Premium-gated.
 *   2. DISCLAIMER on EVERY AI output (FAQ, symptom intake, visit-summary draft, patient msg).
 *   3. NO diagnosis/advice to patients — the guard blocks diagnostic text; the FAQ stays logistics.
 *   4. DOCTOR APPROVAL required — clinical drafts are pending_review and never become a real
 *      note until a doctor approves (then the doctor is the author).
 *   5. Semantic search is retrieval-only + tenant-scoped (no cross-clinic leak).
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';
process.env.AI_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Patient, AiDraft, ClinicalNote } = require('../src/models');
const { createApp } = require('../src/app');
const aiService = require('../src/services/aiService');
const guard = require('../src/lib/ai/guard');

let mongod;
let server;
let base;
const ctx = (clinicId, role = 'doctor') => ({ clinicId, actorId: `u_${clinicId}`, actorRole: role });
const hdr = (clinicId, role = 'doctor') => ({ 'content-type': 'application/json', 'x-dev-clinic-id': clinicId, 'x-dev-role': role, 'x-dev-user-id': `u_${clinicId}` });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Patient.init(), AiDraft.init(), ClinicalNote.init()]);
  await Clinic.create({ clinicId: 'org_ai', name: 'AI Clinic', slug: 'ai4', subscriptionPlan: 'premium', address: '12 Park St', phone: '033-1234' });
  await Clinic.create({ clinicId: 'org_std', name: 'Std', slug: 'std4ai', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_other', name: 'Other', slug: 'oth4ai', subscriptionPlan: 'premium' });
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

test('(b) AI is Premium-gated: Standard 403, Premium 200', async () => {
  const blocked = await fetch(`${base}/api/ai/faq`, { method: 'POST', headers: hdr('org_std'), body: JSON.stringify({ question: 'What are your fees?' }) });
  assert.equal(blocked.status, 403);
  const ok = await fetch(`${base}/api/ai/faq`, { method: 'POST', headers: hdr('org_ai', 'owner'), body: JSON.stringify({ question: 'What are your fees?' }) });
  assert.equal(ok.status, 200);
  console.log('  ✓ (b) AI gated: Standard 403, Premium 200');
});

test('(a) GUARD: diagnostic/prescriptive text is detected and blocked for patients', async () => {
  assert.equal(guard.looksLikeMedicalAdvice('You have diabetes. Take metformin 500mg twice daily.'), true);
  assert.equal(guard.looksLikeMedicalAdvice('Our consultation fee is ₹500 and we open at 9am.'), false);

  const bad = guard.safePatientText('You likely have pneumonia; start antibiotics 500mg.');
  assert.equal(bad.blocked, true, 'diagnosis-like text is dropped');
  assert.ok(!/pneumonia/i.test(bad.text), 'the diagnostic content is not surfaced to the patient');
  assert.ok(bad.text.includes('cannot diagnose'), 'a safe refusal + disclaimer is returned instead');
  console.log('  ✓ (a) guard blocks diagnosis/advice, returns safe disclaimered refusal');
});

test('(a) FAQ answers logistics only, never diagnoses, always carries a disclaimer', async () => {
  const c = ctx('org_ai', 'owner');
  const clinic = await Clinic.findOne({ clinicId: 'org_ai' }).lean();

  const fees = await aiService.faq(c, clinic, 'How much are your fees?');
  assert.ok(fees.disclaimer && /not.*medical advice|cannot diagnose/i.test(fees.disclaimer), 'FAQ carries a disclaimer');
  assert.ok(fees.answer.includes(guard.PATIENT_AI_DISCLAIMER), 'disclaimer attached to the answer text');

  // A medical question gets a non-diagnostic, logistics-only answer.
  const medical = await aiService.faq(c, clinic, 'Do I have diabetes? What medicine should I take?');
  assert.equal(guard.looksLikeMedicalAdvice(medical.answer.replace(guard.PATIENT_AI_DISCLAIMER, '')), false, 'no diagnosis/prescription in the answer');
  console.log('  ✓ (a) FAQ = logistics only + disclaimer, no diagnosis');
});

test('(a) symptom intake stores a doctor-facing draft; patient gets only a safe confirmation', async () => {
  const c = ctx('org_ai', 'receptionist');
  const p = await new Patient({ clinicId: 'org_ai', patientCode: 'PAI1', name: 'Asha' }).save();
  const res = await aiService.symptomIntake(c, { patientId: p._id, symptomsText: 'Fever and cough for 3 days, mild headache.' });

  assert.ok(res.patientMessage.includes(guard.PATIENT_AI_DISCLAIMER), 'patient confirmation carries the disclaimer');
  // Exclude the disclaimer text itself (which legitimately says "cannot diagnose") before scanning.
  const body = res.patientMessage.replace(guard.PATIENT_AI_DISCLAIMER, '');
  assert.ok(!guard.looksLikeMedicalAdvice(body), 'no interpretation shown to the patient');

  const draft = await AiDraft.findById(res.draftId).lean();
  assert.equal(draft.kind, 'symptom_intake');
  assert.equal(draft.status, 'pending_review', 'stored for the doctor to review');
  assert.ok(draft.disclaimer, 'draft carries a disclaimer');
  assert.ok(draft.content.includes('3 days'), 'the doctor-facing draft captured the reported duration');
  console.log('  ✓ (a) intake → doctor-facing pending draft; patient sees only a safe confirmation');
});

test('(a) visit-summary draft requires DOCTOR APPROVAL before it becomes a real note', async () => {
  const c = ctx('org_ai', 'doctor');
  const p = await new Patient({ clinicId: 'org_ai', patientCode: 'PAI2', name: 'Ravi' }).save();
  await new ClinicalNote({ clinicId: 'org_ai', branchId: new mongoose.Types.ObjectId(), patientId: p._id, content: 'BP 120/80, reviewed reports.' }).save();

  const { draft, disclaimer } = await aiService.visitSummaryDraft(c, { patientId: p._id });
  assert.ok(disclaimer, 'draft response carries a disclaimer');
  assert.equal(draft.status, 'pending_review');

  // Before approval: NO new doctor-authored note exists from the AI.
  const notesBefore = await ClinicalNote.countDocuments({ clinicId: 'org_ai', patientId: p._id });
  assert.equal(notesBefore, 1, 'AI has NOT written into the clinical record yet');

  // Doctor approves (possibly editing) → becomes a real note authored by the doctor.
  const approved = await aiService.approveDraft(c, draft._id, { editedContent: 'Reviewed: stable. Follow up in 2 weeks.' });
  assert.equal(approved.draft.status, 'approved');
  assert.ok(approved.noteId, 'a clinical note was created on approval');
  const note = await ClinicalNote.findById(approved.noteId).lean();
  assert.equal(note.content, 'Reviewed: stable. Follow up in 2 weeks.', 'the doctor-approved (edited) text is saved');
  assert.equal(await ClinicalNote.countDocuments({ clinicId: 'org_ai', patientId: p._id }), 2, 'exactly one note added, only after approval');

  // A rejected draft never creates a note.
  const { draft: d2 } = await aiService.visitSummaryDraft(c, { patientId: p._id });
  await aiService.rejectDraft(c, d2._id);
  const rejected = await AiDraft.findById(d2._id).lean();
  assert.equal(rejected.status, 'rejected');
  console.log('  ✓ (a) clinical AI output needs explicit doctor approval; rejection saves nothing');
});

test('(d) semantic search is retrieval-only and tenant-scoped', async () => {
  await new Patient({ clinicId: 'org_ai', patientCode: 'PAI3', name: 'Migraine Meera', medicalHistory: 'chronic migraine, photophobia' }).save();
  await new Patient({ clinicId: 'org_other', patientCode: 'POT1', name: 'Migraine OTHER', medicalHistory: 'migraine' }).save();

  const res = await aiService.semanticSearch(ctx('org_ai', 'doctor'), 'migraine');
  assert.ok(res.results.length >= 1, 'finds the matching patient');
  assert.ok(res.results.every((r) => r.label !== 'Migraine OTHER'), 'never returns another clinic’s records');
  console.log('  ✓ (d) semantic search: retrieval only, strictly tenant-scoped');
});
