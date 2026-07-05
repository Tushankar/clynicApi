'use strict';

const { Clinic, Subscription, Invoice, Payment, Appointment, Doctor } = require('../models');
const { PLANS } = require('../config/plans');
const AppError = require('../utils/AppError');

/**
 * Super-admin platform surface — the cross-clinic control plane. Analytics returns AGGREGATES ONLY
 * (never patient data); the clinic list returns operational metadata (plan, subscription status,
 * dues, last activity) so the platform owner can actually SEE and ACT on a failing clinic, and a
 * force-plan-change lever for support. Not tenant-scoped by design.
 */
// ₹/month for the super-admin MRR estimate (display only; real billing is via Razorpay/invoices).
// ultra_premium is a placeholder mid-range price (pharmacy add-on, spec suggests ₹7,999–14,999) —
// adjust when the tier's pricing is finalized.
const PLAN_PRICES = { basic: 999, standard: 1999, premium: 3999, ultra_premium: 9999 };

async function platformAnalytics() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  const [byPlanAgg, subByStatus, revenueAgg, failedPayments, totalClinics, activeUsageIds] = await Promise.all([
    Clinic.aggregate([{ $group: { _id: '$subscriptionPlan', count: { $sum: 1 } } }]),
    Subscription.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Invoice.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: null, total: { $sum: '$amountPaid' } } }]),
    // Real payment-issue signal: failed captures + abandoned/expired checkouts (the reconciliation
    // sweep writes 'expired'). Previously this counted only status:'failed', which nothing ever
    // wrote, so the cockpit tile was permanently zero.
    Payment.countDocuments({ status: { $in: ['failed', 'expired'] } }),
    Clinic.countDocuments({}),
    Appointment.distinct('clinicId', { createdAt: { $gte: thirtyDaysAgo } }),
  ]);

  const byPlan = byPlanAgg.reduce((acc, g) => ({ ...acc, [g._id || 'basic']: g.count }), {});
  const mrr = byPlanAgg.reduce((s, g) => s + (PLAN_PRICES[g._id] || 0) * g.count, 0);
  const subStatus = subByStatus.reduce((acc, g) => ({ ...acc, [g._id]: g.count }), {});
  const cancelled = subStatus.cancelled || 0;
  const totalSubs = Object.values(subStatus).reduce((a, b) => a + b, 0);

  return {
    clinics: {
      total: totalClinics,
      byPlan,
      activeByUsage: activeUsageIds.length, // clinics with an appointment in the last 30 days
      inactiveByUsage: Math.max(0, totalClinics - activeUsageIds.length),
    },
    revenue: {
      mrr,
      arr: mrr * 12,
      totalCollected: revenueAgg[0]?.total || 0, // sum of paid invoice amounts, all clinics
    },
    // Churn over the WHOLE clinic base (not only clinics that ever transacted) so the % isn't
    // computed on a biased subset dominated by free/basic clinics.
    subscriptions: { byStatus: subStatus, pastDue: subStatus.past_due || 0, churnRate: totalClinics ? Math.round((cancelled / totalClinics) * 1000) / 10 : 0 },
    failedPayments,
    generatedAt: new Date().toISOString(),
  };
}

/** Per-clinic operational list for the platform owner (plan, subscription status, dues, activity). */
async function listClinics({ limit = 300 } = {}) {
  const clinics = await Clinic.find({}, { clinicId: 1, name: 1, slug: 1, subscriptionPlan: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(limit).lean();
  const ids = clinics.map((c) => c.clinicId);
  const [subs, dues, lastActivity, docCounts] = await Promise.all([
    Subscription.find({ clinicId: { $in: ids } }, { clinicId: 1, status: 1 }).lean(),
    Invoice.aggregate([
      { $match: { clinicId: { $in: ids }, deletedAt: null, status: { $in: ['unpaid', 'partially_paid'] } } },
      { $group: { _id: '$clinicId', due: { $sum: { $subtract: ['$total', '$amountPaid'] } } } },
    ]),
    Appointment.aggregate([{ $match: { clinicId: { $in: ids } } }, { $group: { _id: '$clinicId', last: { $max: '$createdAt' } } }]),
    Doctor.aggregate([{ $match: { clinicId: { $in: ids }, isActive: true, deletedAt: null } }, { $group: { _id: '$clinicId', count: { $sum: 1 } } }]),
  ]);
  const subById = new Map(subs.map((s) => [s.clinicId, s.status]));
  const dueById = new Map(dues.map((d) => [d._id, d.due]));
  const lastById = new Map(lastActivity.map((a) => [a._id, a.last]));
  const docById = new Map(docCounts.map((d) => [d._id, d.count]));
  return clinics.map((c) => ({
    clinicId: c.clinicId,
    name: c.name,
    slug: c.slug,
    plan: c.subscriptionPlan || 'basic',
    subscriptionStatus: subById.get(c.clinicId) || null,
    doctors: docById.get(c.clinicId) || 0,
    dues: Math.round((dueById.get(c.clinicId) || 0) * 100) / 100,
    lastActivityAt: lastById.get(c.clinicId) || null,
    createdAt: c.createdAt,
  }));
}

/** Platform-owner override: force a clinic's plan (support / manual provisioning). Audited. */
async function setClinicPlan(clinicId, plan) {
  if (!clinicId) throw new AppError(400, 'clinicId is required');
  if (!PLANS.includes(plan)) throw new AppError(400, 'Invalid plan');
  return require('./subscriptionService').applySubscription(clinicId, plan, plan === 'basic' ? 'cancelled' : 'active');
}

module.exports = { platformAnalytics, listClinics, setClinicPlan, PLAN_PRICES };
