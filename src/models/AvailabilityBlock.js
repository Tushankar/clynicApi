'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable } = require('./plugins');

/**
 * availabilityBlocks — doctor leave, clinic holidays, and ad-hoc slot blocks (§5.20).
 * A block is a [startAt, endAt) window during which no slot may be offered or booked.
 * doctorId null = clinic-wide (holiday): applies to every doctor. Enforced in the slot
 * engine (lib/availability) AND at booking time (appointmentService) — the UI is never
 * the lock. Soft-deletable so removals stay auditable like every tenant write.
 */
const availabilityBlockSchema = new mongoose.Schema(
  {
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null }, // null = whole clinic
    doctorName: { type: String, trim: true }, // denormalized for list views
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    reason: { type: String, trim: true, maxlength: 200 },
    type: { type: String, enum: ['leave', 'holiday', 'block'], default: 'leave' },
    createdBy: { type: String, default: null }, // Clerk user id
  },
  { timestamps: true }
);

clinicScoped(availabilityBlockSchema);
softDeletable(availabilityBlockSchema);
availabilityBlockSchema.index({ clinicId: 1, doctorId: 1, startAt: 1 });
availabilityBlockSchema.index({ clinicId: 1, endAt: 1 });

module.exports = mongoose.model('AvailabilityBlock', availabilityBlockSchema);
