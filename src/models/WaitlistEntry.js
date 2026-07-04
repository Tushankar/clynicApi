'use strict';

const mongoose = require('mongoose');
const { clinicScoped, branchAware } = require('./plugins');

/**
 * waitlistEntries — the cancellation waitlist (§5.21). A patient who found no slot
 * leaves their contact for a doctor+day; when a booking for that doctor+day is
 * cancelled (or rescheduled away), waiting entries are notified with a booking link.
 * Contact info is patient-provided public input — display it, never trust it.
 */
const waitlistEntrySchema = new mongoose.Schema(
  {
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    doctorName: { type: String, trim: true },
    date: { type: Date, required: true }, // start of the requested local day
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    status: { type: String, enum: ['waiting', 'notified', 'booked', 'removed'], default: 'waiting' },
    source: { type: String, enum: ['public', 'staff'], default: 'public' },
    notifiedAt: { type: Date, default: null },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

clinicScoped(waitlistEntrySchema);
branchAware(waitlistEntrySchema);
waitlistEntrySchema.index({ clinicId: 1, doctorId: 1, date: 1, status: 1 });
waitlistEntrySchema.index({ clinicId: 1, status: 1, date: 1 });

module.exports = mongoose.model('WaitlistEntry', waitlistEntrySchema);
