'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable } = require('./plugins');

/**
 * patients — clinical record, scoped to a clinic (NOT to a single branch: a patient
 * belongs to the clinic and can be seen at any branch).
 *
 * Soft-deletable (hard rule 6). Phase 0 fields are intentionally lean (name, phone,
 * dob, gender, notes + visit-tracking); full medical history arrives in Phase 2.
 */
const emergencyContactSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    relation: { type: String, trim: true },
  },
  { _id: false }
);

const insuranceSchema = new mongoose.Schema(
  {
    provider: { type: String, trim: true },
    policyNumber: { type: String, trim: true },
  },
  { _id: false }
);

const patientSchema = new mongoose.Schema(
  {
    patientCode: { type: String, required: true, trim: true }, // unique per clinic
    name: { type: String, required: true, trim: true },
    dob: { type: Date },
    gender: { type: String, enum: ['male', 'female', 'other', 'unspecified'], default: 'unspecified' },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    notes: { type: String, trim: true },

    // Phase 2 medical fields
    bloodGroup: { type: String, trim: true },
    medicalHistory: { type: String, trim: true }, // past conditions / surgeries (free text)
    allergies: { type: [String], default: [] },
    currentMedications: { type: [String], default: [] },
    emergencyContact: { type: emergencyContactSchema },
    insurance: { type: insuranceSchema },

    // CRM / retention fields (section 5.13)
    lastVisitAt: { type: Date, default: null },
    visitCount: { type: Number, default: 0 },
    tags: { type: [String], default: [] }, // e.g. 'high_value', 'repeat'

    /**
     * Marketing consent. There was previously NO way to record that a patient had asked to stop
     * receiving campaign messages, and no code path that would have honoured one — birthday and
     * re-engagement mail went to every patient with a contact, indefinitely. For unsolicited
     * commercial messaging under India's DPDP Act that is a legal exposure, not a preference.
     *
     * Scope is MARKETING ONLY. Transactional messages — appointment reminders, OTPs, invoices,
     * "your turn" nudges — are not covered by this flag: a patient who opts out of birthday wishes
     * still needs to be told their appointment moved. `commsService.sendCampaignMessage` is the
     * single funnel every campaign goes through, so the check lives there.
     *
     * Defaults to false (opted IN) to preserve existing behaviour for records created before this
     * field existed; flipping the default is a business/legal decision, not a code one.
     */
    marketingOptOut: { type: Boolean, default: false },
    marketingOptOutAt: { type: Date, default: null },
    followUpAt: { type: Date, default: null }, // next recommended follow-up (powers CRM "follow-ups due")
  },
  { timestamps: true }
);

clinicScoped(patientSchema);
softDeletable(patientSchema);

// patientCode is unique per clinic (not globally).
patientSchema.index({ clinicId: 1, patientCode: 1 }, { unique: true });
// Phone lookup within a clinic (receptionist search).
patientSchema.index({ clinicId: 1, phone: 1 });
// Gmail-style universal search (section 5.15) — text index across the searchable fields.
patientSchema.index({ name: 'text', phone: 'text', notes: 'text' });

module.exports = mongoose.model('Patient', patientSchema);
