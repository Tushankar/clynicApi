'use strict';

const mongoose = require('mongoose');
const { clinicScoped } = require('./plugins');

/**
 * reminders — the DB-of-record for scheduled notifications (section 6). On booking
 * we create two (24h + 2h) with status 'scheduled'. The BullMQ worker (or, when no
 * Redis, the manual processor) sends them via the provider-agnostic notification
 * service and flips status to 'sent'. The unique { appointmentId, type } index makes
 * scheduling idempotent — never two of the same reminder for one appointment (9.2).
 */
const reminderSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    type: { type: String, required: true }, // 'appointment_24h' | 'appointment_2h' | ...
    channel: { type: String, enum: ['email', 'sms', 'whatsapp'], default: 'email' },
    sendAt: { type: Date, required: true },
    status: { type: String, enum: ['scheduled', 'sent', 'failed', 'cancelled'], default: 'scheduled' },
    payload: {
      to: { type: String },
      subject: { type: String },
      message: { type: String },
      email: { type: String, default: null }, // both contacts kept → dual-channel delivery
      phone: { type: String, default: null }, //   + email fallback when WhatsApp fails
    },
    sentAt: { type: Date },
    error: { type: String },
    jobId: { type: String }, // BullMQ job id when Redis-backed
  },
  { timestamps: true }
);

clinicScoped(reminderSchema);
reminderSchema.index({ clinicId: 1, status: 1, sendAt: 1 });
reminderSchema.index({ appointmentId: 1, type: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Reminder', reminderSchema);
