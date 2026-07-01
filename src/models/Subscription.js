'use strict';

const mongoose = require('mongoose');
const { clinicScoped } = require('./plugins');
const { PLANS } = require('../config/plans');

/**
 * subscriptions — a clinic's plan subscription (Razorpay-linked). The webhook that
 * flips status/plan also updates clinics.subscriptionPlan, which automatically drives
 * plan gating via §6.5 (no code change). Plan changes are money events → audited.
 */
const subscriptionSchema = new mongoose.Schema(
  {
    plan: { type: String, enum: PLANS, required: true },
    status: { type: String, enum: ['active', 'past_due', 'cancelled'], default: 'active' },
    provider: { type: String, default: 'razorpay' },
    providerSubscriptionId: { type: String, default: null },
    currentPeriodEnd: { type: Date, default: null },
  },
  { timestamps: true }
);

clinicScoped(subscriptionSchema, { unique: true }); // one subscription per clinic

module.exports = mongoose.model('Subscription', subscriptionSchema);
