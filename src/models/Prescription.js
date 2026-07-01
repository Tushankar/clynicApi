'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * prescriptions — clinical record (hard rules 6, 7, 8). Soft-deletable, audited,
 * branch-aware. Items are { drug, dose, frequency, duration }.
 */
const itemSchema = new mongoose.Schema(
  {
    drug: { type: String, required: true, trim: true },
    dose: { type: String, trim: true },
    frequency: { type: String, trim: true },
    duration: { type: String, trim: true },
  },
  { _id: false }
);

const prescriptionSchema = new mongoose.Schema(
  {
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    patientName: { type: String, trim: true }, // denormalized for fast lists + printing
    doctorName: { type: String, trim: true },
    items: { type: [itemSchema], default: [] },
    notes: { type: String, trim: true },
    diagnosis: { type: String, trim: true },
  },
  { timestamps: true }
);

clinicScoped(prescriptionSchema);
branchAware(prescriptionSchema);
softDeletable(prescriptionSchema);

prescriptionSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });
prescriptionSchema.index({ clinicId: 1, appointmentId: 1 });

module.exports = mongoose.model('Prescription', prescriptionSchema);
