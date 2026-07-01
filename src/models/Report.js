'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * reports — uploaded medical files (PDF / X-ray / blood test). HARD RULE 3:
 * files are PRIVATE. We store an opaque storageKey (never a public URL); the
 * bytes are served only via short-lived signed URLs, and each view is audited.
 */
const reportSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    type: { type: String, enum: ['lab', 'xray', 'prescription', 'discharge', 'other'], default: 'other' },
    title: { type: String, trim: true },

    // Private storage — NOT a public URL.
    storageDriver: { type: String, enum: ['local', 's3'], required: true },
    storageKey: { type: String, required: true }, // opaque key/path in the private bucket
    originalName: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    size: { type: Number },

    uploadedByStaffId: { type: String, default: null },
  },
  { timestamps: true }
);

clinicScoped(reportSchema);
branchAware(reportSchema);
softDeletable(reportSchema);
reportSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });

module.exports = mongoose.model('Report', reportSchema);
