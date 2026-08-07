'use strict';

const { planHasFeature, effectivePlan } = require('../config/plans');

/**
 * Plan-gate middleware (hard rule 5). The backend is the real lock — never the UI.
 *
 * Usage (Phase 2+):
 *   router.post('/prescriptions', requireFeature('PRESCRIPTIONS'), handler)
 *
 * Locked features return 403 with an "upgrade_required" payload. The plan comes
 * from req.clinic.subscriptionPlan (loaded by attachAuthContext). NO Phase 0 route
 * uses this yet — it is wired so Phase 2+ features attach it with zero new plumbing.
 */
function requireFeature(featureKey) {
  return function featureGuard(req, res, next) {
    if (!req.clinic?.subscriptionPlan) {
      return res.status(401).json({ error: 'No clinic context' });
    }
    // Entitlement, not the nominal tier: a cancelled or long-past_due clinic falls back to Basic.
    // See config/plans.js effectivePlan.
    const plan = effectivePlan(req.clinic);
    if (!planHasFeature(plan, featureKey)) {
      const lapsed = plan !== req.clinic.subscriptionPlan;
      return res.status(403).json({
        error: lapsed ? 'subscription_inactive' : 'upgrade_required',
        feature: featureKey,
        plan,
        paidPlan: req.clinic.subscriptionPlan,
        message: lapsed
          ? 'Your subscription is not active, so paid features are paused. Update your payment method to restore them.'
          : 'This feature is not available on your current plan.',
      });
    }
    next();
  };
}

module.exports = { requireFeature };
