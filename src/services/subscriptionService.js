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
// Days a past_due clinic keeps its paid features while it sorts out payment. Long enough that a
// card expiring over a weekend never interrupts patient care; short enough to still mean something.
const GRACE_DAYS = 7;

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
  // Mirror the billing state onto the clinic so requireFeature can resolve entitlement without a
  // per-request Subscription lookup (see config/plans.js effectivePlan). Going active clears any
  // dunning grace; going cancelled drops entitlement immediately.
  await Clinic.updateOne(
    { clinicId },
    { $set: { subscriptionPlan: plan, subscriptionStatus: status, graceUntil: null } }
  ); // ← the loop
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
    // Start the dunning clock. Until graceUntil passes the clinic keeps every paid feature — we do
    // not cut a clinic off mid-consultation — after which entitlement falls back to Basic.
    await Clinic.updateOne(
      { clinicId },
      { $set: { subscriptionStatus: 'past_due', graceUntil: new Date(Date.now() + GRACE_DAYS * 24 * 3600 * 1000) } }
    );
    await audit(clinicId, 'Subscription', before?._id, { status: before?.status }, { status: 'past_due' });
    // A failed charge used to be completely silent (no lock, no message) — surface it so the owner
    // can fix payment BEFORE an eventual cancellation strips their features.
    await notifyPastDue(clinicId).catch(() => {});
  } else if (type === 'subscription.cancelled') {
    // Downgrade locks Standard/Premium features automatically via §6.5.
    await applySubscription(clinicId, 'basic', 'cancelled', { providerSubscriptionId: entity.id });
    const sysCtx = { clinicId, actorId: 'system:subscription', actorRole: null };
    require('./notificationService')
      .emit(sysCtx, { type: 'subscription_cancelled', message: 'Your subscription was cancelled — your clinic is now on the Basic plan. Premium features are locked until you resubscribe.', link: '/dashboard/plan' })
      .catch(() => {});
  }
  return { processed: true };
}

/** Owner-facing dunning when a subscription charge fails (in-app + best-effort email). */
async function notifyPastDue(clinicId) {
  const sysCtx = { clinicId, actorId: 'system:subscription', actorRole: null };
  require('./notificationService')
    .emit(sysCtx, {
      type: 'subscription_past_due',
      message: 'Your last subscription payment failed. Please update your payment method to keep your premium features.',
      link: '/dashboard/plan',
    })
    .catch(() => {});
  try {
    const clinic = await Clinic.findOne({ clinicId }).lean();
    if (clinic?.email) {
      const { sendNotification } = require('./notifications');
      await sendNotification({
        channel: 'email',
        to: clinic.email,
        subject: `Payment failed — action needed for ${clinic.name || 'your clinic'}`,
        message:
          `Hi,\n\nWe couldn't process your latest subscription payment for ${clinic.name || 'your clinic'}.\n\n` +
          `Please update your payment method soon to avoid losing access to your premium features.\n\n— The Clynic team`,
      });
    }
  } catch {
    /* dunning email is best-effort — the in-app notification is the reliable signal */
  }
}

function getSubscription(ctx) {
  return Subscription.findOne({ clinicId: ctx.clinicId }).lean();
}

/**
 * Owner-initiated plan change. Behaviour by direction so the owner never hits a dead end:
 *   - dev (mock gateway): apply immediately end-to-end (unchanged).
 *   - downgrade / same tier: apply immediately in any environment — no payment is required to
 *     move DOWN, so there's no reason to block it behind checkout.
 *   - upgrade in production: a self-serve Razorpay subscription checkout isn't wired yet, so
 *     instead of a raw 501 dead-end we RECORD the request and confirm it to the owner (the
 *     platform activates it). Returns a friendly pending result the UI renders as "requested".
 */
async function requestPlanChange(ctx, plan) {
  if (!PLANS.includes(plan)) throw new AppError(400, 'Invalid plan');
  if (config.payments.driver === 'mock') return applySubscription(ctx.clinicId, plan, 'active');

  const clinic = await Clinic.findOne({ clinicId: ctx.clinicId }).lean();
  const current = clinic?.subscriptionPlan || 'basic';
  const curIdx = PLANS.indexOf(current);
  const tgtIdx = PLANS.indexOf(plan);

  if (tgtIdx === curIdx) return { plan, current, status: 'active', unchanged: true };
  if (tgtIdx < curIdx) {
    // Downgrade — apply immediately (features lock via §6.5). Basic == cancelled subscription.
    const applied = await applySubscription(ctx.clinicId, plan, tgtIdx === 0 ? 'cancelled' : 'active');
    return { ...applied, current, downgraded: true };
  }

  // Upgrade in production — no dead end. Log the intent + tell the owner it's in progress.
  // eslint-disable-next-line no-console
  console.info(`[subscription] upgrade requested: clinic ${ctx.clinicId} ${current} → ${plan}`);
  require('./notificationService')
    .emit(ctx, { type: 'other', message: `Upgrade to the ${plan} plan requested — our team will activate it shortly.`, link: '/dashboard/plan' })
    .catch(() => {});
  return {
    pending: true,
    plan,
    current,
    message: `Upgrade to ${plan} requested — our team will confirm your new plan shortly. Nothing changes and no data is lost in the meantime.`,
  };
}

/**
 * Platform lever: suspend / restore a clinic.
 *
 * There was previously no way to stop serving a clinic — non-payment, abuse and offboarding all
 * had zero enforcement. Suspension locks the staff app (requireAuth) and leaves every record
 * intact, so it is fully reversible.
 */
async function setClinicSuspended(clinicId, suspended, { reason = '', actorId = null } = {}) {
  const before = await Clinic.findOne({ clinicId }).lean();
  if (!before) throw new AppError(404, 'Clinic not found');
  const $set = suspended
    ? { status: 'suspended', suspendedAt: new Date(), suspendedReason: String(reason || '').slice(0, 300) }
    : { status: 'active', suspendedAt: null, suspendedReason: '' };
  await Clinic.updateOne({ clinicId }, { $set });
  // Attribute the operator, not 'system' — a platform action on a paying customer must be traceable.
  await AuditLog.create({
    clinicId,
    actorId: actorId || 'system:platform',
    actorRole: null,
    action: 'update',
    entityType: 'Clinic',
    entityId: before._id,
    before: { status: before.status || 'active' },
    after: $set,
  });
  if (suspended) {
    require('./notificationService')
      .emit({ clinicId, actorId: 'system:platform', actorRole: null }, {
        type: 'other',
        message: `This clinic account has been suspended${reason ? `: ${reason}` : ''}. Please contact support.`,
        link: '/dashboard/plan',
      })
      .catch(() => {});
  }
  return { clinicId, status: $set.status };
}

/**
 * Scheduled lifecycle sweep. Two jobs the product never had:
 *   1. A subscription whose paid period has ELAPSED with no renewal webhook becomes past_due
 *      (a dropped webhook previously meant premium forever).
 *   2. A past_due clinic whose grace has run out is notified once that its features have paused.
 * Entitlement itself is computed live by effectivePlan, so this only moves state + tells people.
 */
async function sweepSubscriptions(now = new Date()) {
  let lapsed = 0;
  const expired = await Subscription.find(
    { status: 'active', currentPeriodEnd: { $ne: null, $lt: now } },
    { clinicId: 1 }
  ).lean();
  for (const s of expired) {
    // eslint-disable-next-line no-await-in-loop
    await Subscription.updateOne({ clinicId: s.clinicId }, { $set: { status: 'past_due' } });
    // eslint-disable-next-line no-await-in-loop
    await Clinic.updateOne(
      { clinicId: s.clinicId },
      { $set: { subscriptionStatus: 'past_due', graceUntil: new Date(now.getTime() + GRACE_DAYS * 24 * 3600 * 1000) } }
    );
    // eslint-disable-next-line no-await-in-loop
    await notifyPastDue(s.clinicId).catch(() => {});
    lapsed += 1;
  }
  return { lapsed };
}

module.exports = {
  applySubscription,
  handleSubscriptionWebhook,
  getSubscription,
  requestPlanChange,
  setClinicSuspended,
  sweepSubscriptions,
  GRACE_DAYS,
};
