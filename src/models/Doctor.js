'use strict';

const mongoose = require('mongoose');
const { clinicScoped } = require('./plugins');

/**
 * doctors — a clinic's practitioners. Availability is a weekly schedule of working
 * windows; slots are generated from it minus already-booked appointments (Phase 1).
 * Calendar upgrades (recurringSlots, vacations, blockedDays) are Phase 2 (5.14);
 * the fields exist now so the schema doesn't need retrofitting.
 */
const windowSchema = new mongoose.Schema(
  { start: { type: String }, end: { type: String } }, // 'HH:mm'
  { _id: false }
);

const doctorSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff' }, // optional link to a staff member
    name: { type: String, required: true, trim: true },
    specialization: { type: String, trim: true },
    consultationFee: { type: Number, default: 0 },

    // Weekly availability: { mon: [{start,end}], tue: [...], ... }
    availability: {
      type: Map,
      of: [windowSchema],
      default: {},
    },
    slotDurationMinutes: { type: Number, default: 15, min: 5 },
    appointmentBufferMinutes: { type: Number, default: 0, min: 0 },

    // Phase 2 (5.14) — declared now, unused in Phase 1 UI.
    blockedDays: { type: [Date], default: [] },
    vacations: { type: [{ from: Date, to: Date, _id: false }], default: [] },

    color: { type: String, default: '#0d9488' }, // calendar accent
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

clinicScoped(doctorSchema);
doctorSchema.index({ clinicId: 1, isActive: 1 });

module.exports = mongoose.model('Doctor', doctorSchema);
