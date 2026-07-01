'use strict';

const { Clinic, Subscription, Invoice, Payment, Appointment } = require('../models');

/**
 * Super-admin platform analytics — the ONE cross-clinic read. Returns AGGREGATES ONLY
 * (counts and sums); never any clinic's patient data. Not tenant-scoped by design.
 */
const PLAN_PRICES = { basic: 999, standard: 1999, premium: 3999 }; // ₹/month (§12)

async function platformAnalytics() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  const [byPlanAgg, subByStatus, revenueAgg, failedPayments, totalClinics, activeUsageIds] = await Promise.all([
    Clinic.aggregate([{ $group: { _id: '$subscriptionPlan', count: { $sum: 1 } } }]),
    Subscription.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Invoice.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: null, total: { $sum: '$amountPaid' } } }]),
    Payment.countDocuments({ status: 'failed' }),
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
    subscriptions: { byStatus: subStatus, churnRate: totalSubs ? Math.round((cancelled / totalSubs) * 1000) / 10 : 0 },
    failedPayments,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { platformAnalytics, PLAN_PRICES };
