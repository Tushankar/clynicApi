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
    // NOTE: keep this list in sync with the events emitted across the app. notificationService.emit
    // coerces any unknown type to 'other' (and logs) so a future emitter can never SILENTLY drop a
    // notification via enum validation — a bug that previously hid review/waitlist alerts entirely.
    type: {
      type: String,
      enum: [
        'appointment_booked',
        'appointment_confirmed',
        'appointment_cancelled',
        'appointment_rescheduled',
        'reminder_sent',
        'reminder_failed',
        'payment_received',
        'payment_refunded',
        'subscription_past_due',
        'subscription_cancelled',
        'doctor_unavailable',
        'availability_block_impact',
        'lab_report_uploaded',
        'lab_request_created',
        'lab_request_completed',
        'prescription_created',
        'review_received',
        'waitlist_joined',
        'waitlist_slot_freed',
        // Pharmacy & Vendor module (Ultra Premium, §6.3) — stock health alerts to pharmacy staff.
        'low_stock',
        'stock_expiry',
        // Pharmacy storefront (Ultra Premium, §6.6) — new order (→ staff), order status (→ patient).
        'store_order',
        'order_status',
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
