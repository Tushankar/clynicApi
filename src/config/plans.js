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

// Ordered by rank — index encodes tier level (see requestPlanChange's indexOf upgrade/downgrade
// math). `ultra_premium` is APPENDED at the end so it ranks above premium and the existing
// tiers keep their indices (0/1/2). It is a strict SUPERSET of premium (see planHasFeature).
const PLANS = ['basic', 'standard', 'premium', 'ultra_premium'];

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

  // Patient self-service: tokenized reschedule/cancel links in confirmations +
  // reminders. Part of the core booking loop, so every plan gets it.
  SELF_RESCHEDULE: ['basic', 'standard', 'premium'],

  // Scheduling operations (Phase 5)
  AVAILABILITY_BLOCKS: ['standard', 'premium'], // doctor leave / clinic holidays / ad-hoc blocks
  WAITLIST: ['standard', 'premium'], // cancellation waitlist + auto-notify

  // Money operations (Phase 5) — India-first billing depth.
  PAYMENT_LINKS: ['standard', 'premium'], // send a pay-online link for an invoice's dues
  CASH_REGISTER: ['standard', 'premium'], // day-end register: totals by method + dues
  DOCUMENT_SHARING: ['standard', 'premium'], // invoice/prescription share links via email/WhatsApp
  DATA_EXPORT: ['standard', 'premium'], // CSV export of patients/appointments/invoices

  // CRM & retention: Standard gets the CRM + automated campaigns (birthday wishes,
  // follow-up reminders) with the professional DEFAULT templates. Editing those
  // templates and AI-personalized campaign text are Premium-only.
  CRM: ['standard', 'premium'],
  CRM_AUTOMATION: ['standard', 'premium'],
  REVIEW_REQUESTS: ['standard', 'premium'], // post-visit "rate your visit" flow → website reviews
  TEMPLATE_EDITING: ['premium'],

  // Premium (Phase 4)
  MULTI_BRANCH: ['premium'],
  ANALYTICS: ['premium'],
  AI_FEATURES: ['premium'], // AI is NOT in Standard — Premium only
  CMS_ADVANCED: ['premium'], // custom pages, blog, reviews, SEO, richer theme (§5.19 / 8.6)

  // Premium (Phase 5)
  SELF_CHECKIN: ['premium'], // QR self check-in kiosk → live queue
  RECALLS: ['premium'], // treatment recalls ("cleaning due in 6 months")
  EXPENSES: ['premium'], // expense tracking + P&L view in analytics

  // ── Pharmacy & Vendor module (Ultra Premium ONLY) ────────────────────────────
  // The gating vocabulary for the whole pharmacy add-on. These map ONLY to the new
  // tier, so they resolve false for basic/standard/premium — the module is invisible
  // and inert on every lower tier. UP-A wires PHARMACY_MANAGEMENT (catalog + inventory
  // + stock alerts); later phases (UP-B..UP-E) attach the rest. ultra_premium also
  // inherits every premium feature above via planHasFeature (strict superset).
  PHARMACY_MANAGEMENT: ['ultra_premium'], // medicine catalog + inventory (batches, availability, alerts)
  SUPPLIER_PROCUREMENT: ['ultra_premium'], // suppliers + purchase orders + expenses (UP-B)
  MEDICINE_DISPENSING: ['ultra_premium'], // prescription-linked dispensing (UP-C)
  DOSAGE_MANAGEMENT: ['ultra_premium'], // patient dosage schedules + reminders (UP-C)
  PHARMACY_STOREFRONT: ['ultra_premium'], // public Apollo-style store (UP-D)
  PHARMACY_ANALYTICS: ['ultra_premium'], // pharmacy revenue/margin/valuation (UP-E)
};

// Numeric limits per plan (enforce separately from feature flags).
// NOTE: limitsForPlan falls back to LIMITS.basic for any plan missing here, so a new
// tier MUST have an entry or it would silently inherit Basic's caps (1 doctor/branch).
const LIMITS = {
  basic: { maxDoctors: 1, maxBranches: 1 },
  standard: { maxDoctors: 5, maxBranches: 1 },
  premium: { maxDoctors: Infinity, maxBranches: Infinity },
  ultra_premium: { maxDoctors: Infinity, maxBranches: Infinity }, // superset of premium
};

function planHasFeature(plan, featureKey) {
  const allowed = FEATURES[featureKey] || [];
  if (allowed.includes(plan)) return true;
  // ultra_premium is a strict SUPERSET of premium (spec §4): it inherits every premium
  // feature without each one having to list 'ultra_premium'. This branch only fires for
  // the new tier, so basic/standard/premium resolution is byte-for-byte unchanged — which
  // makes the strict-superset guarantee structural (a premium feature can never be missed).
  if (plan === 'ultra_premium' && allowed.includes('premium')) return true;
  return false;
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
