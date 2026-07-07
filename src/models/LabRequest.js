'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/** One measured result line (value is a string so "12.3", "Positive", "Not detected" all fit). */
const labResultSchema = new mongoose.Schema(
  {
    test: { type: String, trim: true }, // which ordered test this row reports
    value: { type: String, trim: true },
    unit: { type: String, trim: true },
    refRange: { type: String, trim: true }, // reference / normal range
    flag: { type: String, enum: ['normal', 'low', 'high', 'abnormal', ''], default: '' },
  },
  { _id: false }
);

/**
 * labRequests — tests ordered during a consultation (clinical; rules 6, 7, 8). The result fields
 * close the "order → collect → result" loop that previously dead-ended at status='completed' with
 * nowhere to store what came back.
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
    // Results captured against the order (was missing entirely).
    results: { type: [labResultSchema], default: [] },
    resultNotes: { type: String, trim: true }, // interpretation / summary
    resultReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'Report', default: null }, // optional attached file
    resultedAt: { type: Date, default: null },
    resultedBy: { type: String, default: null }, // Clerk user id
  },
  { timestamps: true }
);

clinicScoped(labRequestSchema);
branchAware(labRequestSchema);
softDeletable(labRequestSchema);
labRequestSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });

module.exports = mongoose.model('LabRequest', labRequestSchema);
