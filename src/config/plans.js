'use strict';

/**
 * Plan gating — SINGLE SOURCE OF TRUTH (hard rule 5).
 *
 * The backend decides what a clinic can access based on clinics.subscriptionPlan.
 * Never scatter `if (plan === 'premium')` across the codebase — always go through
 * planHasFeature() / the requireFeature() middleware.
 *
 * Phase 0 note: NO routes are gated yet. This wires up the structure so Phase 2+
 * features attach `requireFeature('KEY')` with zero new plumbing.
 */

const PLANS = ['basic', 'standard', 'premium'];

// Each feature is a stable key. A plan includes a feature if listed.
const FEATURES = {
  // Basic (Phase 1)
  ONLINE_BOOKING: ['basic', 'standard', 'premium'],
  LIVE_QUEUE: ['basic', 'standard', 'premium'],
  SMS_REMINDERS: ['basic', 'standard', 'premium'],
  RECEPTION_DASHBOARD: ['basic', 'standard', 'premium'],

  // Standard (Phase 2 + 3)
  DOCTOR_DASHBOARD: ['standard', 'premium'],
  DOCTOR_CALENDAR: ['standard', 'premium'],
  PRESCRIPTIONS: ['standard', 'premium'],
  PATIENT_TIMELINE: ['standard', 'premium'],
  REPORT_UPLOADS: ['standard', 'premium'],
  BILLING: ['standard', 'premium'],
  PATIENT_PORTAL: ['standard', 'premium'],
  UNIVERSAL_SEARCH: ['standard', 'premium'],
  INTERNAL_CHAT: ['standard', 'premium'],
  NOTIFICATION_CENTER: ['standard', 'premium'],
  ONLINE_PREPAYMENT: ['standard', 'premium'],
  WHATSAPP_REMINDERS: ['standard', 'premium'],
  CMS_BASIC: ['standard', 'premium'], // edit website content/theme (§5.19 / 8.6)

  // All plans — every clinic gets a live public website (§5.19)
  WEBSITE_LIVE: ['basic', 'standard', 'premium'],

  // CRM & retention: Standard gets the CRM + automated campaigns (birthday wishes,
  // follow-up reminders) with the professional DEFAULT templates. Editing those
  // templates and AI-personalized campaign text are Premium-only.
  CRM: ['standard', 'premium'],
  CRM_AUTOMATION: ['standard', 'premium'],
  TEMPLATE_EDITING: ['premium'],

  // Premium (Phase 4)
  MULTI_BRANCH: ['premium'],
  ANALYTICS: ['premium'],
  AI_FEATURES: ['premium'], // AI is NOT in Standard — Premium only
  CMS_ADVANCED: ['premium'], // custom pages, blog, reviews, SEO, richer theme (§5.19 / 8.6)
};

// Numeric limits per plan (enforce separately from feature flags).
const LIMITS = {
  basic: { maxDoctors: 1, maxBranches: 1 },
  standard: { maxDoctors: 5, maxBranches: 1 },
  premium: { maxDoctors: Infinity, maxBranches: Infinity },
};

function planHasFeature(plan, featureKey) {
  return (FEATURES[featureKey] || []).includes(plan);
}

/**
 * Resolve the full set of feature flags a plan unlocks.
 * Used by GET /me/plan so the frontend can hide/disable locked UI
 * (convenience only — the backend middleware is the real lock).
 */
function resolveFeatures(plan) {
  const flags = {};
  for (const key of Object.keys(FEATURES)) {
    flags[key] = planHasFeature(plan, key);
  }
  return flags;
}

function limitsForPlan(plan) {
  return LIMITS[plan] || LIMITS.basic;
}

module.exports = {
  PLANS,
  FEATURES,
  LIMITS,
  planHasFeature,
  resolveFeatures,
  limitsForPlan,
};
