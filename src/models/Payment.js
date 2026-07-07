'use strict';

const mongoose = require('mongoose');
const { clinicScoped, branchAware, softDeletable } = require('./plugins');

/**
 * payments — a Razorpay order/payment attempt + its verified outcome (financial;
 * audited). Idempotency: a successful paymentId is applied exactly once
 * (unique { clinicId, paymentId } sparse index), so a replayed callback/webhook
 * can never double-credit.
 */
const paymentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['invoice', 'prepayment', 'subscription'], required: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },

    provider: { type: String, default: 'razorpay' },
    orderId: { type: String, required: true },
    paymentId: { type: String, default: null },
    amount: { type: Number, required: true }, // ₹
    currency: { type: String, default: 'INR' },
    // created → processing (claimed, side effect running) → paid. 'processing' is
    // re-claimable so an apply that fails after the claim is retried (payment rule 2).
    // 'expired' = an abandoned checkout the reconciliation sweep closed (never captured).
    status: { type: String, enum: ['created', 'processing', 'paid', 'failed', 'refunded', 'expired'], default: 'created' },
    signatureVerified: { type: Boolean, default: false },
    method: { type: String },
    // Gateway refunds issued back against this captured payment. Sum → amountRefunded; when it
    // reaches `amount` the payment is 'refunded'. Populated by the Razorpay refund API + refund.* webhook.
    amountRefunded: { type: Number, default: 0 },
    refunds: {
      type: [
        new mongoose.Schema(
          {
            refundId: { type: String }, // gateway refund id (rfnd_...)
            amount: { type: Number },
            reason: { type: String },
            status: { type: String, default: 'processed' }, // processed | pending | failed
            at: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

clinicScoped(paymentSchema);
branchAware(paymentSchema);
softDeletable(paymentSchema); // financial record — never hard-deleted (rule 6), like Invoice

paymentSchema.index({ clinicId: 1, orderId: 1 }, { unique: true });
// Idempotency anchor: a captured paymentId can be applied once per clinic.
// Partial (only when paymentId is a string) so multiple unpaid orders (paymentId null)
// in one clinic do NOT collide — sparse alone wouldn't, since the field defaults to null.
paymentSchema.index({ clinicId: 1, paymentId: 1 }, { unique: true, partialFilterExpression: { paymentId: { $type: 'string' } } });

module.exports = mongoose.model('Payment', paymentSchema);
