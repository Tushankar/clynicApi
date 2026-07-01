'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * labRequests — tests ordered during a consultation (clinical; rules 6, 7, 8).
 */
const labRequestSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
    patientName: { type: String, trim: true },
    tests: { type: [String], default: [] },
    status: { type: String, enum: ['requested', 'collected', 'completed', 'cancelled'], default: 'requested' },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

clinicScoped(labRequestSchema);
branchAware(labRequestSchema);
softDeletable(labRequestSchema);
labRequestSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });

module.exports = mongoose.model('LabRequest', labRequestSchema);
