'use strict';

const { Clinic, Subscription, AuditLog } = require('../models');
const { PLANS } = require('../config/plans');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Closes the §6.5 loop: a verified Razorpay subscription webhook flips
 * clinics.subscriptionPlan, which automatically drives plan gating (requireFeature
 * reads req.clinic.subscriptionPlan per request) with NO code change. Plan changes
 * are money events → audited.
 */
async function audit(clinicId, entityType, entityId, before, after) {
  await AuditLog.create({ clinicId, actorId: 'system:subscription', actorRole: null, action: 'update', entityType, entityId, before, after });
}

async function applySubscription(clinicId, plan, status, extra = {}) {
  if (!PLANS.includes(plan)) throw new AppError(400, 'Invalid plan');

  const subBefore = await Subscription.findOne({ clinicId }).lean();
  const sub = await Subscription.findOneAndUpdate(
    { clinicId },
    { $set: { clinicId, plan, status, provider: 'razorpay', ...extra } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  // Audit the subscription money-event itself (queryable by entityType:'Subscription').
  await audit(clinicId, 'Subscription', sub._id, { plan: subBefore?.plan, status: subBefore?.status }, { plan, status, ...extra });

  const clinicBefore = await Clinic.findOne({ clinicId }).lean();
  await Clinic.updateOne({ clinicId }, { $set: { subscriptionPlan: plan } }); // ← the loop
  // Only audit the Clinic entity if a clinic row exists (entityId is required). A subscription
  // change for an org with no clinic row still records the Subscription audit above.
  if (clinicBefore?._id) {
    await audit(clinicId, 'Clinic', clinicBefore._id, { subscriptionPlan: clinicBefore.subscriptionPlan }, { subscriptionPlan: plan, status });
  }
  return { clinicId, plan, status };
}

/** Apply a subscription webhook event (idempotency is handled upstream by the event de-dup). */
async function handleSubscriptionWebhook(event) {
  const entity = event.payload?.subscription?.entity || {};
  const clinicId = entity.notes?.clinicId;
  const plan = entity.notes?.plan;
  if (!clinicId) return { skipped: true };
  const type = event.event;

  if (type === 'subscription.activated' || type === 'subscription.charged') {
    if (plan) {
      await applySubscription(clinicId, plan, 'active', {
        providerSubscriptionId: entity.id,
        currentPeriodEnd: entity.current_end ? new Date(entity.current_end * 1000) : null,
      });
    }
  } else if (type === 'subscription.halted' || type === 'subscription.pending') {
    const before = await Subscription.findOne({ clinicId }).lean();
    await Subscription.updateOne({ clinicId }, { $set: { status: 'past_due' } });
    await audit(clinicId, 'Subscription', before?._id, { status: before?.status }, { status: 'past_due' });
  } else if (type === 'subscription.cancelled') {
    // Downgrade locks Standard/Premium features automatically via §6.5.
    await applySubscription(clinicId, 'basic', 'cancelled', { providerSubscriptionId: entity.id });
  }
  return { processed: true };
}

function getSubscription(ctx) {
  return Subscription.findOne({ clinicId: ctx.clinicId }).lean();
}

/**
 * Owner-initiated plan change. In production this creates a Razorpay subscription and
 * the authoritative change arrives via webhook; in dev (mock) it applies immediately
 * so the loop is demonstrable end to end.
 */
async function requestPlanChange(ctx, plan) {
  if (!PLANS.includes(plan)) throw new AppError(400, 'Invalid plan');
  if (config.payments.driver === 'mock') return applySubscription(ctx.clinicId, plan, 'active');
  throw new AppError(501, 'Live subscription checkout is configured via Razorpay subscriptions + webhook');
}

module.exports = { applySubscription, handleSubscriptionWebhook, getSubscription, requestPlanChange };
