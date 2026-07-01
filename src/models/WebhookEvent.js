'use strict';

const mongoose = require('mongoose');

/**
 * webhookEvents — de-dup ledger for payment webhooks (payment rule 2). The provider
 * event id is globally unique, so inserting it is the idempotency gate: a second
 * delivery of the same event collides on the unique index and is skipped. Not
 * clinic-scoped (events arrive globally before we resolve a clinic).
 */
const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, default: 'razorpay' },
    eventId: { type: String, required: true },
    type: { type: String },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
