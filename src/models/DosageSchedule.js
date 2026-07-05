'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable } = require('./plugins');

/**
 * dosageSchedules — the patient's "how to take it" plan for a dispensed/ordered medicine
 * (Ultra Premium, §6.5). Created alongside a dispense; drives the patient's current-medicines view
 * and (optionally) medicine reminders. Patient-clinical record → soft-deletable + audited; not
 * branch-scoped (belongs to the patient, not a branch).
 */
const dosageScheduleSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
    medicineName: { type: String, trim: true }, // snapshot
    sourceType: { type: String, enum: ['dispense', 'order'], default: 'dispense' },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null }, // the dispense/order id
    dosage: { type: String, trim: true }, // e.g. "1-0-1"
    timing: { type: String, trim: true }, // e.g. "after food"
    durationDays: { type: Number, min: 0, default: null },
    instructions: { type: String, trim: true },
    startDate: { type: Date, default: Date.now },
    endDate: { type: Date, default: null }, // startDate + durationDays (computed at creation)
    remindersEnabled: { type: Boolean, default: false },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

clinicScoped(dosageScheduleSchema);
softDeletable(dosageScheduleSchema);
dosageScheduleSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });

module.exports = mongoose.model('DosageSchedule', dosageScheduleSchema);
