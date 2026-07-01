'use strict';

const { AiDraft, Patient, Doctor, ClinicalNote, Prescription, Appointment } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const ai = require('../lib/ai');
const { AI_DISCLAIMER, PATIENT_AI_DISCLAIMER, withDisclaimer, safePatientText, looksLikeMedicalAdvice } = require('../lib/ai/guard');
const clinicalNoteService = require('./clinicalNoteService');
const AppError = require('../utils/AppError');

/**
 * AI assistant service (§5.10) — HARD RULE 2 is enforced structurally here:
 *  - FAQ + symptom intake are PATIENT-FACING → routed through safePatientText (refuses any
 *    diagnosis/advice) and always disclaimered. They never tell a patient anything clinical.
 *  - Visit summaries / note drafts are CLINICAL → saved as pending_review AiDrafts that a
 *    doctor must approve before they become a real ClinicalNote (the doctor is the author).
 *  - Semantic search is retrieval only (no generation) and tenant-scoped.
 */

// ---- (a) FAQ receptionist — logistics only, never medical --------------------------
async function faq(ctx, clinic, question) {
  if (!question || !question.trim()) throw new AppError(400, 'Ask a question');
  const doctors = await tenantRepo(Doctor, ctx).find({ isActive: true }, { lean: true });
  const raw = await ai.faqAnswer({ question, clinic: { name: clinic.name, address: clinic.address, phone: clinic.phone }, doctors });
  const safe = safePatientText(raw); // drops anything advice-like, attaches patient disclaimer
  return { answer: safe.text, disclaimer: PATIENT_AI_DISCLAIMER, blocked: safe.blocked, model: ai.model };
}

// ---- (b) Symptom intake — collects, never diagnoses --------------------------------
/**
 * Structure a patient's described symptoms into a neutral summary FOR THE DOCTOR and store
 * it as a pending_review draft. The patient only gets a confirmation + disclaimer back —
 * never an interpretation. `ctx` may be a public (patient) or staff context.
 */
async function symptomIntake(ctx, { patientId, appointmentId, symptomsText }) {
  if (!symptomsText || !symptomsText.trim()) throw new AppError(400, 'Please describe your symptoms');
  const patient = await tenantRepo(Patient, ctx).findById(patientId);
  if (!patient) throw new AppError(404, 'Patient not found');

  const content = await ai.structureSymptoms({ symptomsText, patient: { name: patient.name } });
  const flagged = looksLikeMedicalAdvice(content);
  const draft = await tenantRepo(AiDraft, ctx).create({
    kind: 'symptom_intake',
    patientId,
    appointmentId: appointmentId || undefined,
    source: { symptomsText },
    content, // doctor-facing structured summary
    disclaimer: AI_DISCLAIMER,
    model: `${ai.driver}:${ai.model}`,
    flagged,
  });
  // The PATIENT sees only a safe confirmation — never clinical interpretation.
  return {
    ok: true,
    draftId: String(draft._id),
    patientMessage: withDisclaimer('Thanks — your symptoms have been shared with your doctor, who will review them at your visit.', PATIENT_AI_DISCLAIMER),
    disclaimer: PATIENT_AI_DISCLAIMER,
  };
}

// ---- (c) Visit summary draft — for doctor review/approval --------------------------
async function visitSummaryDraft(ctx, { patientId, appointmentId }) {
  const patient = await tenantRepo(Patient, ctx).findById(patientId);
  if (!patient) throw new AppError(404, 'Patient not found');
  const [notes, prescriptions, appointment] = await Promise.all([
    tenantRepo(ClinicalNote, ctx).find({ patientId }, { sort: { createdAt: -1 }, limit: 5, lean: true }),
    tenantRepo(Prescription, ctx).find({ patientId }, { sort: { createdAt: -1 }, limit: 5, lean: true }),
    appointmentId ? tenantRepo(Appointment, ctx).findById(appointmentId) : null,
  ]);

  const content = await ai.draftVisitSummary({ patient: { name: patient.name }, appointment: appointment || {}, notes, prescriptions });
  const flagged = looksLikeMedicalAdvice(content);
  const draft = await tenantRepo(AiDraft, ctx).create({
    kind: 'visit_summary',
    patientId,
    appointmentId: appointmentId || undefined,
    doctorId: undefined,
    source: { noteCount: notes.length, prescriptionCount: prescriptions.length },
    content,
    disclaimer: AI_DISCLAIMER,
    model: `${ai.driver}:${ai.model}`,
    flagged,
  });
  return { draft: publicDraft(draft), disclaimer: AI_DISCLAIMER };
}

// ---- Doctor approval workflow ------------------------------------------------------
function publicDraft(d) {
  return {
    _id: String(d._id),
    kind: d.kind,
    patientId: d.patientId ? String(d.patientId) : null,
    appointmentId: d.appointmentId ? String(d.appointmentId) : null,
    content: d.content,
    approvedContent: d.approvedContent,
    disclaimer: d.disclaimer,
    status: d.status,
    flagged: d.flagged,
    model: d.model,
    reviewedBy: d.reviewedBy,
    reviewedAt: d.reviewedAt,
    resultNoteId: d.resultNoteId ? String(d.resultNoteId) : null,
    createdAt: d.createdAt,
  };
}

function listDrafts(ctx, { status = 'pending_review', patientId, kind } = {}) {
  const filter = {};
  if (status && status !== 'all') filter.status = status;
  if (patientId) filter.patientId = patientId;
  if (kind) filter.kind = kind;
  return tenantRepo(AiDraft, ctx)
    .find(filter, { sort: { createdAt: -1 }, limit: 100, lean: true })
    .then((rows) => rows.map(publicDraft));
}

/**
 * Doctor approves a clinical AI draft. The approved text (possibly edited by the doctor)
 * becomes a real ClinicalNote AUTHORED BY THE DOCTOR — the AI never writes the record itself.
 * Idempotent-ish: only pending drafts can be approved.
 */
async function approveDraft(ctx, draftId, { editedContent, doctorId } = {}) {
  const repo = tenantRepo(AiDraft, ctx);
  const draft = await repo.findById(draftId);
  if (!draft) throw new AppError(404, 'Draft not found');
  if (draft.status !== 'pending_review') throw new AppError(409, `Draft already ${draft.status}`);

  const finalContent = (editedContent && editedContent.trim()) || draft.content;
  let resultNoteId = null;

  // Clinical drafts become a doctor-authored note on approval. (Intake stays an intake record.)
  if (draft.kind === 'visit_summary' || draft.kind === 'clinical_note') {
    const note = await clinicalNoteService.create(ctx, {
      patientId: draft.patientId,
      appointmentId: draft.appointmentId,
      doctorId: doctorId || draft.doctorId,
      content: finalContent, // doctor is the author of the saved record
    });
    resultNoteId = note._id;
  }

  const updated = await repo.updateById(draftId, {
    status: 'approved',
    reviewedBy: ctx.actorId || null,
    reviewedAt: new Date(),
    approvedContent: finalContent,
    resultNoteId,
  });
  return { draft: publicDraft(updated), noteId: resultNoteId ? String(resultNoteId) : null };
}

async function rejectDraft(ctx, draftId) {
  const repo = tenantRepo(AiDraft, ctx);
  const draft = await repo.findById(draftId);
  if (!draft) throw new AppError(404, 'Draft not found');
  if (draft.status !== 'pending_review') throw new AppError(409, `Draft already ${draft.status}`);
  const updated = await repo.updateById(draftId, { status: 'rejected', reviewedBy: ctx.actorId || null, reviewedAt: new Date() });
  return { draft: publicDraft(updated) };
}

// ---- (d) Semantic search — retrieval only, tenant-scoped ---------------------------
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'for', 'with', 'in', 'on', 'is', 'patient']);
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t));

/**
 * Semantic-lite search across the clinic's patients, notes, and prescriptions. Ranks by
 * token overlap (a stand-in for embeddings that needs no external service and never leaves
 * the tenant). Pure retrieval — generates no text, so there is no rule-2 surface. Results
 * are strictly clinic-scoped via TenantRepository.
 */
async function semanticSearch(ctx, query, { limit = 15 } = {}) {
  if (!query || !query.trim()) return { results: [] };
  const qTokens = tokens(query);
  if (!qTokens.length) return { results: [] };
  const score = (text) => {
    const t = new Set(tokens(text));
    return qTokens.reduce((s, q) => s + (t.has(q) ? 1 : 0), 0);
  };

  const [patients, notes, prescriptions] = await Promise.all([
    tenantRepo(Patient, ctx).find({}, { limit: 500, lean: true }),
    tenantRepo(ClinicalNote, ctx).find({}, { limit: 500, lean: true }),
    tenantRepo(Prescription, ctx).find({}, { limit: 500, lean: true }),
  ]);

  const scored = [];
  for (const p of patients) {
    const s = score([p.name, p.phone, p.notes, p.medicalHistory, (p.allergies || []).join(' '), (p.tags || []).join(' ')].join(' '));
    if (s > 0) scored.push({ type: 'patient', id: String(p._id), label: p.name, snippet: p.medicalHistory || p.notes || p.phone || '', score: s, patientId: String(p._id) });
  }
  for (const n of notes) {
    const s = score(n.content);
    if (s > 0) scored.push({ type: 'note', id: String(n._id), label: 'Clinical note', snippet: String(n.content).slice(0, 140), score: s, patientId: String(n.patientId) });
  }
  for (const rx of prescriptions) {
    const text = (rx.items || []).map((i) => `${i.drug} ${i.notes || ''}`).join(' ') + ' ' + (rx.notes || '');
    const s = score(text);
    if (s > 0) scored.push({ type: 'prescription', id: String(rx._id), label: 'Prescription', snippet: text.slice(0, 140), score: s, patientId: String(rx.patientId) });
  }
  scored.sort((a, b) => b.score - a.score);
  return { results: scored.slice(0, limit), query };
}

module.exports = { faq, symptomIntake, visitSummaryDraft, listDrafts, approveDraft, rejectDraft, semanticSearch };
