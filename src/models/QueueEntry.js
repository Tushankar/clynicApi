'use strict';

const mongoose = require('mongoose');
const { clinicScoped, branchAware } = require('./plugins');
const { QUEUE_STATUSES } = require('../config/appointments');

/**
 * queueEntries — the live waiting-room queue (section 5.3 / 6). Operational and
 * branch-aware (hard rule 8). One entry per appointment (unique) so a patient
 * can't be checked in twice. High-frequency operational data — tenant-isolated
 * but not audited (audit:false at the repo) to keep the trail meaningful.
 */
const queueEntrySchema = new mongoose.Schema(
  {
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
    patientName: { type: String, trim: true }, // denormalized for the TV display
    tokenNumber: { type: Number },
    // The clinic-day this entry belongs to ('YYYY-MM-DD'). The live queue is a TODAY view, but it
    // used to be selected purely by status — so an entry left 'waiting' or 'in_consultation' at
    // closing time stayed live forever and collided with the next day's token numbers (tokens
    // restart at 1 daily). Scoping reads by dayKey makes the queue self-clearing.
    dayKey: { type: String, index: true },
    status: { type: String, enum: QUEUE_STATUSES, default: 'waiting', required: true },
    calledAt: { type: Date },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    estimatedWaitMinutes: { type: Number, default: 0 },
  },
  { timestamps: true }
);

clinicScoped(queueEntrySchema);
branchAware(queueEntrySchema, { required: true });

queueEntrySchema.index({ clinicId: 1, branchId: 1, status: 1, createdAt: 1 });
queueEntrySchema.index({ clinicId: 1, branchId: 1, dayKey: 1, status: 1 }); // the live "today" queue
queueEntrySchema.index({ clinicId: 1, appointmentId: 1 }, { unique: true });

module.exports = mongoose.model('QueueEntry', queueEntrySchema);
