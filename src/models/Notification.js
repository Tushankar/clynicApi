'use strict';

const mongoose = require('mongoose');
const { clinicScoped, branchAware } = require('./plugins');

/**
 * notifications — in-app event feed (§5.17 / 6). Separate from outbound reminder
 * channels. Tenant-isolated + branch-aware; high-frequency, so not audited.
 * recipientId is a Clerk user id (staff) or patient id.
 */
const notificationSchema = new mongoose.Schema(
  {
    recipientType: { type: String, enum: ['staff', 'patient'], default: 'staff' },
    recipientId: { type: String, default: null }, // null = broadcast to all clinic staff
    type: {
      type: String,
      enum: [
        'appointment_confirmed',
        'appointment_cancelled',
        'reminder_sent',
        'payment_received',
        'doctor_unavailable',
        'lab_report_uploaded',
        'lab_request_created',
        'prescription_created',
        'other',
      ],
      default: 'other',
    },
    message: { type: String, required: true, trim: true },
    link: { type: String, trim: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

clinicScoped(notificationSchema);
branchAware(notificationSchema);
notificationSchema.index({ clinicId: 1, recipientId: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
