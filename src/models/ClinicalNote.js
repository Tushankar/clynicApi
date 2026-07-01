'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * clinicalNotes — consultation notes (clinical; hard rules 6, 7, 8).
 * patientId is added (beyond §6) so notes list per patient + feed the timeline.
 */
const clinicalNoteSchema = new mongoose.Schema(
  {
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
    doctorName: { type: String, trim: true },
    content: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

clinicScoped(clinicalNoteSchema);
branchAware(clinicalNoteSchema);
softDeletable(clinicalNoteSchema);
clinicalNoteSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });

module.exports = mongoose.model('ClinicalNote', clinicalNoteSchema);
