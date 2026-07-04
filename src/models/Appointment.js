'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');
const { APPOINTMENT_STATUSES, APPOINTMENT_SOURCES } = require('../config/appointments');

/**
 * appointments — operational + clinical (hard rules 6, 7, 8).
 * branchId required (branch-aware), soft-deletable, and audited via the tenant repo.
 */
const appointmentSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },

    // Denormalized for fast, join-free operational lists (day view, dashboard, TV).
    // Set at booking; same-clinic by construction so this never crosses tenants.
    patientName: { type: String, trim: true },
    patientPhone: { type: String, trim: true },
    doctorName: { type: String, trim: true },

    scheduledAt: { type: Date, required: true },
    endAt: { type: Date },
    durationMinutes: { type: Number, default: 15 },

    status: { type: String, enum: APPOINTMENT_STATUSES, default: 'booked', required: true },
    source: { type: String, enum: APPOINTMENT_SOURCES, default: 'walkin' },
    tokenNumber: { type: Number },

    reason: { type: String, trim: true },
    notes: { type: String, trim: true },
    prepaid: { type: Boolean, default: false },
    prepaymentId: { type: String, default: null }, // links to the capturing payment

    bookedByStaffId: { type: String, default: null }, // Clerk user id, or null for public/online
    cancelledReason: { type: String, trim: true },
    reviewRequestSentAt: { type: Date, default: null }, // post-visit review ask (once per appointment)
    reviewSubmittedAt: { type: Date, default: null }, // patient submitted a rating via the review link
  },
  { timestamps: true }
);

clinicScoped(appointmentSchema);
branchAware(appointmentSchema, { required: true });
softDeletable(appointmentSchema);

appointmentSchema.index({ clinicId: 1, branchId: 1, scheduledAt: 1 });
appointmentSchema.index({ clinicId: 1, doctorId: 1, scheduledAt: 1 });
appointmentSchema.index({ clinicId: 1, patientId: 1, scheduledAt: -1 });
appointmentSchema.index({ clinicId: 1, status: 1 });

module.exports = mongoose.model('Appointment', appointmentSchema);
