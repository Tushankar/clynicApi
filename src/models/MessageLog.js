'use strict';

const mongoose = require('mongoose');
const { clinicScoped } = require('./plugins');

/**
 * messagelogs — a record of every OUTBOUND communication the clinic sends (re-engagement
 * emails, appointment reminders, …). Gives the owner a "what did we send, to whom, how many
 * times, which template" view (§5.13/5.17). Tenant-isolated; high-frequency → not audited.
 *
 * `template` names the message kind so the UI can group/count by it. This enum MUST list every
 * template the code actually records — messageLogService.record coerces an unknown template to
 * 'custom' (and logs) as a backstop, because a validation throw here would silently drop the row
 * (both the sent AND the failed record), hiding whether patients were ever contacted.
 */
const messageLogSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
    patientName: { type: String, trim: true },
    channel: { type: String, enum: ['email', 'sms', 'whatsapp'], default: 'email' },
    template: {
      type: String,
      enum: [
        'reengage',
        'birthday',
        'followup',
        'appointment_24h',
        'appointment_2h',
        'booking_confirmation',
        'appointment_cancelled',
        'appointment_rescheduled',
        'review_request',
        'recall',
        'waitlist',
        'payment_link',
        'document',
        'custom',
      ],
      default: 'custom',
    },
    subject: { type: String, trim: true },
    to: { type: String, trim: true },
    status: { type: String, enum: ['sent', 'failed'], default: 'sent' },
    error: { type: String },
    sentBy: { type: String, default: null }, // actor id, or 'system' for automated sends
    sentByRole: { type: String, default: null },
  },
  { timestamps: true }
);

clinicScoped(messageLogSchema);
messageLogSchema.index({ clinicId: 1, createdAt: -1 });
messageLogSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });

module.exports = mongoose.model('MessageLog', messageLogSchema);
