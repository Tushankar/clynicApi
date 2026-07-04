'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable } = require('./plugins');

/**
 * recalls — treatment recalls (§5.22, Premium): "cleaning due in 6 months",
 * "annual check-up", etc. A recall is scheduled against a patient with a due date;
 * the campaign tick sends the reminder (with a booking link) when it falls due and
 * flips status to 'sent'. Any new booking for the patient closes open recalls as
 * 'booked'. Clinical-adjacent patient data → soft-deletable + audited via tenantRepo.
 */
const recallSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    patientName: { type: String, trim: true }, // denormalized for list views
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
    doctorName: { type: String, trim: true },
    label: { type: String, required: true, trim: true, maxlength: 120 }, // e.g. "6-month cleaning"
    dueDate: { type: Date, required: true },
    // 'sending' = claimed by the scheduler (concurrency guard); 'failed' = delivery didn't succeed
    // (undeliverable / both channels failed) so staff can see it instead of a false green 'sent'.
    status: { type: String, enum: ['scheduled', 'sending', 'sent', 'failed', 'booked', 'cancelled'], default: 'scheduled' },
    sentAt: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

clinicScoped(recallSchema);
softDeletable(recallSchema);
recallSchema.index({ clinicId: 1, status: 1, dueDate: 1 });
recallSchema.index({ clinicId: 1, patientId: 1, dueDate: -1 });

module.exports = mongoose.model('Recall', recallSchema);
