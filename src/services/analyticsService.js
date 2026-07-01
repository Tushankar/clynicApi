'use strict';

const mongoose = require('mongoose');
const { Invoice, Appointment, Patient } = require('../models');

/**
 * Owner analytics (§5.9) — CLINIC-SCOPED aggregations (revenue, patients, doctors, peak
 * hours, no-show + follow-up rates). Unlike the platform super-admin analytics, this
 * NEVER crosses clinics: every aggregation pipeline $matches ctx.clinicId explicitly
 * (aggregations bypass TenantRepository, so this match IS the tenant-isolation guarantee —
 * hard rule 1). An optional branchId narrows the operational metrics.
 */

const DAY = 24 * 3600 * 1000;
const TZ = 'Asia/Kolkata'; // clinics are in Kolkata (§0)
// "Seen" = the patient actually attended (not merely booked, and not a no-show/cancellation).
const ATTENDED_STATUSES = ['checked_in', 'in_consultation', 'completed'];

function parseRange({ from, to } = {}) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 29 * DAY);
  return { start, end };
}

function branchMatch(branchId) {
  if (branchId && mongoose.isValidObjectId(branchId)) return { branchId: new mongoose.Types.ObjectId(branchId) };
  return {};
}

async function overview(ctx, { from, to, branchId } = {}) {
  const { start, end } = parseRange({ from, to });
  const clinicId = ctx.clinicId; // ← tenant-isolation anchor for every pipeline below
  const bm = branchMatch(branchId);

  const invMatch = { clinicId, deletedAt: null, createdAt: { $gte: start, $lte: end }, ...bm };
  const apptMatch = { clinicId, deletedAt: null, scheduledAt: { $gte: start, $lte: end }, ...bm };

  const [revenueByDayAgg, revenueTotalAgg, statusAgg, hourAgg, doctorAgg, patientIds] = await Promise.all([
    Invoice.aggregate([
      { $match: invMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } }, revenue: { $sum: '$amountPaid' } } },
      { $sort: { _id: 1 } },
    ]),
    Invoice.aggregate([{ $match: invMatch }, { $group: { _id: null, revenue: { $sum: '$amountPaid' }, invoices: { $sum: 1 } } }]),
    Appointment.aggregate([{ $match: apptMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Appointment.aggregate([
      { $match: apptMatch },
      { $group: { _id: { $hour: { date: '$scheduledAt', timezone: TZ } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Appointment.aggregate([
      { $match: { ...apptMatch, status: 'completed' } },
      { $group: { _id: { id: '$doctorId', name: '$doctorName' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),
    Appointment.distinct('patientId', { ...apptMatch, status: { $in: ATTENDED_STATUSES } }),
  ]);

  const byStatus = statusAgg.reduce((acc, g) => ({ ...acc, [g._id]: g.count }), {});
  const totalAppts = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const noShow = byStatus.no_show || 0;
  const cancelled = byStatus.cancelled || 0;
  // No-show rate over appointments that were actually expected (exclude cancellations).
  const expected = totalAppts - cancelled;
  const noShowRate = expected > 0 ? Math.round((noShow / expected) * 1000) / 10 : 0;

  // New vs returning: of the distinct patients seen in range, who was registered inside
  // the window (new) vs before it (returning). Clinic-scoped (ids come from apptMatch).
  let newPatients = 0;
  let returningPatients = 0;
  if (patientIds.length) {
    const patients = await Patient.find({ clinicId, _id: { $in: patientIds } }, { createdAt: 1 }).lean();
    for (const p of patients) {
      if (p.createdAt >= start) newPatients += 1;
      else returningPatients += 1;
    }
  }

  // Follow-up completion: of patients whose follow-up is due (followUpAt <= now), how many
  // returned since (lastVisitAt >= followUpAt). Clinic-scoped counts.
  const now = new Date();
  const [dueFollowUps, completedFollowUps] = await Promise.all([
    Patient.countDocuments({ clinicId, deletedAt: null, followUpAt: { $ne: null, $lte: now } }),
    Patient.countDocuments({ clinicId, deletedAt: null, followUpAt: { $ne: null, $lte: now }, $expr: { $gte: ['$lastVisitAt', '$followUpAt'] } }),
  ]);
  const followUpCompletionRate = dueFollowUps > 0 ? Math.round((completedFollowUps / dueFollowUps) * 1000) / 10 : 0;

  const peakHours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourAgg.find((x) => x._id === h)?.count || 0 }));

  return {
    range: { from: start.toISOString(), to: end.toISOString() },
    revenue: {
      total: revenueTotalAgg[0]?.revenue || 0,
      invoices: revenueTotalAgg[0]?.invoices || 0,
      byDay: revenueByDayAgg.map((d) => ({ date: d._id, revenue: d.revenue })),
    },
    appointments: { total: totalAppts, byStatus, noShowRate },
    patients: { seen: patientIds.length, new: newPatients, returning: returningPatients },
    doctors: { mostVisited: doctorAgg.map((d) => ({ name: d._id.name || 'Unknown', count: d.count })) },
    peakHours,
    followUp: { due: dueFollowUps, completed: completedFollowUps, completionRate: followUpCompletionRate },
    generatedAt: now.toISOString(),
  };
}

module.exports = { overview };
