'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * aiDrafts — the DOCTOR-APPROVAL workflow that enforces hard rule 2 for CLINICAL AI output.
 *
 * Any AI-generated clinical content (symptom intake, visit summary, drafted note) is stored
 * here as a DRAFT with status 'pending_review'. It is NEVER written into the real clinical
 * record (clinicalNotes/prescriptions) until a doctor explicitly approves it — at which
 * point the doctor becomes the author. Every draft carries the not-medical-advice disclaimer,
 * and `flagged` marks drafts where the safety guard detected diagnosis-like language.
 * Clinical/AI data → soft-deletable + audited + branch-aware (hard rules 6, 7, 8).
 */
const aiDraftSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['symptom_intake', 'visit_summary', 'clinical_note'], required: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },

    source: { type: mongoose.Schema.Types.Mixed }, // the structured input handed to the model (transparency)
    content: { type: String, required: true }, // the AI draft
    disclaimer: { type: String, required: true }, // always present (rule 2)
    model: { type: String }, // driver + model id that produced it
    flagged: { type: Boolean, default: false }, // guard detected diagnosis-like language → extra scrutiny

    status: { type: String, enum: ['pending_review', 'approved', 'rejected'], default: 'pending_review', required: true },
    reviewedBy: { type: String, default: null }, // Clerk user id of the approving/rejecting doctor
    reviewedAt: { type: Date, default: null },
    approvedContent: { type: String, default: null }, // final text the doctor approved (may be edited)
    resultNoteId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClinicalNote', default: null }, // note created on approval
  },
  { timestamps: true }
);

clinicScoped(aiDraftSchema);
branchAware(aiDraftSchema);
softDeletable(aiDraftSchema);
aiDraftSchema.index({ clinicId: 1, status: 1, createdAt: -1 });
aiDraftSchema.index({ clinicId: 1, patientId: 1 });

module.exports = mongoose.model('AiDraft', aiDraftSchema);
