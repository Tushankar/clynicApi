'use strict';

const { planHasFeature } = require('../config/plans');

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
    const plan = req.clinic?.subscriptionPlan; // set by auth middleware from clinicId
    if (!plan) {
      return res.status(401).json({ error: 'No clinic context' });
    }
    if (!planHasFeature(plan, featureKey)) {
      return res.status(403).json({
        error: 'upgrade_required',
        feature: featureKey,
        plan,
        message: 'This feature is not available on your current plan.',
      });
    }
    next();
  };
}

module.exports = { requireFeature };
