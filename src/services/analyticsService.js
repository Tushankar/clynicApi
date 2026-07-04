'use strict';

const mongoose = require('mongoose');
const { Invoice, Appointment, Patient, Doctor, Expense, AvailabilityBlock } = require('../models');
const { planHasFeature } = require('../config/plans');

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

// ---- Depth helpers (§5.24) -----------------------------------------------------------

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** How many of each weekday (0=Sun..6=Sat) occur in [start, end]. */
function weekdayCounts(start, end) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= stop) {
    counts[cur.getDay()] += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return counts;
}

function windowMinutes(w) {
  const [sh, sm] = String(w?.start || '0:0').split(':').map(Number);
  const [eh, em] = String(w?.end || '0:0').split(':').map(Number);
  return Math.max(0, (eh || 0) * 60 + (em || 0) - ((sh || 0) * 60 + (sm || 0)));
}

const availToObject = (a) => (a instanceof Map ? Object.fromEntries(a) : a?.toObject ? a.toObject() : a || {});

/**
 * Doctor utilization over the range: booked minutes (non-cancelled appointments) vs
 * offerable minutes (weekly availability × weekday occurrences − leave blocks).
 */
async function doctorUtilization({ clinicId, start, end, apptMatch }) {
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const [doctors, bookedAgg, blocks] = await Promise.all([
    Doctor.find({ clinicId, isActive: true }).lean(),
    Appointment.aggregate([
      { $match: { ...apptMatch, status: { $nin: ['cancelled'] } } },
      { $group: { _id: '$doctorId', minutes: { $sum: { $ifNull: ['$durationMinutes', 15] } }, count: { $sum: 1 } } },
    ]),
    AvailabilityBlock.find({ clinicId, deletedAt: null, startAt: { $lt: end }, endAt: { $gt: start } }).lean(),
  ]);
  const bookedBy = new Map(bookedAgg.map((b) => [String(b._id), b]));
  const dowCounts = weekdayCounts(start, end);

  return doctors
    .map((d) => {
      const avail = availToObject(d.availability);
      let availableMinutes = 0;
      for (let dow = 0; dow < 7; dow += 1) {
        const windows = avail[DAY_KEYS[dow]] || [];
        const perDay = windows.reduce((s, w) => s + windowMinutes(w), 0);
        availableMinutes += perDay * dowCounts[dow];
      }
      // Subtract leave: clip each block (own or clinic-wide) to the range.
      for (const b of blocks) {
        if (b.doctorId && String(b.doctorId) !== String(d._id)) continue;
        const bs = Math.max(new Date(b.startAt).getTime(), start.getTime());
        const be = Math.min(new Date(b.endAt).getTime(), end.getTime());
        if (be > bs) availableMinutes -= Math.round((be - bs) / 60000);
      }
      availableMinutes = Math.max(0, availableMinutes);
      const booked = bookedBy.get(String(d._id)) || { minutes: 0, count: 0 };
      const utilization = availableMinutes > 0 ? Math.min(100, Math.round((booked.minutes / availableMinutes) * 100)) : 0;
      return { doctorId: String(d._id), name: d.name, bookedMinutes: booked.minutes, appointments: booked.count, availableMinutes, utilization };
    })
    .sort((a, b) => b.utilization - a.utilization);
}

/** Last-N-months key list like ['2026-02', ..., '2026-07'] (oldest first). */
function monthKeys(n, now = new Date()) {
  const keys = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

async function overview(ctx, { from, to, branchId, plan } = {}) {
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

  // Lapsed / at-risk retention (§5.13) — surfaced here on the owner's revenue view, not only buried
  // in the CRM segment. Includes patients who came once and never returned (lastVisitAt null but
  // registered long ago), which the CRM "lapsed" segment previously excluded.
  const LAPSED_DAYS = 182;
  const lapsedCutoff = new Date(now.getTime() - LAPSED_DAYS * 86400000);
  const [lapsedSeen, neverReturned] = await Promise.all([
    Patient.countDocuments({ clinicId, deletedAt: null, lastVisitAt: { $ne: null, $lt: lapsedCutoff } }),
    Patient.countDocuments({ clinicId, deletedAt: null, lastVisitAt: null, createdAt: { $lt: lapsedCutoff } }),
  ]);

  const peakHours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourAgg.find((x) => x._id === h)?.count || 0 }));

  // ---- Depth (§5.24): heatmap, revenue by service, utilization, monthly trend, P&L ----
  const months = monthKeys(6, end);
  const monthStart = new Date(end.getFullYear(), end.getMonth() - 5, 1);

  const [heatmapAgg, serviceAgg, utilization, newPatientsAgg, visitsAgg, revenueMonthAgg, expenseMonthAgg] = await Promise.all([
    // Bookings + no-shows per weekday × hour over the range.
    Appointment.aggregate([
      { $match: apptMatch },
      {
        $group: {
          _id: { dow: { $dayOfWeek: { date: '$scheduledAt', timezone: TZ } }, hour: { $hour: { date: '$scheduledAt', timezone: TZ } } },
          total: { $sum: 1 },
          noShow: { $sum: { $cond: [{ $eq: ['$status', 'no_show'] }, 1, 0] } },
        },
      },
    ]),
    // Revenue by billed line item (top services by collected-share of invoice).
    Invoice.aggregate([
      { $match: invMatch },
      { $unwind: '$items' },
      {
        $group: {
          _id: { $toLower: { $trim: { input: '$items.description' } } },
          label: { $first: '$items.description' },
          amount: { $sum: { $multiply: ['$items.amount', { $ifNull: ['$items.quantity', 1] }] } },
          count: { $sum: { $ifNull: ['$items.quantity', 1] } },
        },
      },
      { $sort: { amount: -1 } },
      { $limit: 8 },
    ]),
    doctorUtilization({ clinicId, start, end, apptMatch }).catch(() => []),
    // 6-month growth trend: new patient registrations vs patient visits per month.
    Patient.aggregate([
      { $match: { clinicId, deletedAt: null, createdAt: { $gte: monthStart, $lte: end } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: TZ } }, count: { $sum: 1 } } },
    ]),
    Appointment.aggregate([
      { $match: { clinicId, deletedAt: null, status: { $in: ATTENDED_STATUSES }, scheduledAt: { $gte: monthStart, $lte: end }, ...bm } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$scheduledAt', timezone: TZ } }, count: { $sum: 1 } } },
    ]),
    // P&L inputs (Premium/EXPENSES): money actually collected per month vs expenses.
    planHasFeature(plan, 'EXPENSES')
      ? Invoice.aggregate([
          { $match: { clinicId, deletedAt: null, ...bm } },
          { $unwind: '$payments' },
          { $match: { 'payments.paidAt': { $gte: monthStart, $lte: end } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$payments.paidAt', timezone: TZ } }, amount: { $sum: '$payments.amount' } } },
        ])
      : Promise.resolve(null),
    planHasFeature(plan, 'EXPENSES')
      ? Expense.aggregate([
          { $match: { clinicId, deletedAt: null, date: { $gte: monthStart, $lte: end } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date', timezone: TZ } }, amount: { $sum: '$amount' } } },
        ])
      : Promise.resolve(null),
  ]);

  // $dayOfWeek is 1=Sun..7=Sat → normalize to 0..6.
  const heatmap = heatmapAgg.map((c) => ({ dow: (c._id.dow || 1) - 1, hour: c._id.hour, total: c.total, noShow: c.noShow }));

  const byMonth = (agg, key = 'count') => {
    const map = new Map((agg || []).map((m) => [m._id, m[key] ?? m.amount ?? 0]));
    return months.map((m) => map.get(m) || 0);
  };

  let pnl = null;
  if (revenueMonthAgg && expenseMonthAgg) {
    const rev = byMonth(revenueMonthAgg, 'amount');
    const exp = byMonth(expenseMonthAgg, 'amount');
    pnl = months.map((m, i) => ({ month: m, revenue: rev[i], expenses: exp[i], net: Math.round((rev[i] - exp[i]) * 100) / 100 }));
  }

  return {
    range: { from: start.toISOString(), to: end.toISOString() },
    revenue: {
      total: revenueTotalAgg[0]?.revenue || 0,
      invoices: revenueTotalAgg[0]?.invoices || 0,
      byDay: revenueByDayAgg.map((d) => ({ date: d._id, revenue: d.revenue })),
    },
    appointments: { total: totalAppts, byStatus, noShowRate },
    patients: { seen: patientIds.length, new: newPatients, returning: returningPatients },
    retention: { lapsed: lapsedSeen + neverReturned, lapsedSeen, neverReturned, sinceDays: LAPSED_DAYS },
    doctors: { mostVisited: doctorAgg.map((d) => ({ name: d._id.name || 'Unknown', count: d.count })) },
    peakHours,
    followUp: { due: dueFollowUps, completed: completedFollowUps, completionRate: followUpCompletionRate },
    // Depth (§5.24)
    heatmap: { dowLabels: DOW_LABELS, cells: heatmap },
    revenueByService: serviceAgg.map((s) => ({ label: s.label || s._id, amount: Math.round(s.amount * 100) / 100, count: s.count })),
    utilization,
    trend: { months, newPatients: byMonth(newPatientsAgg), visits: byMonth(visitsAgg) },
    pnl, // null unless the plan includes EXPENSES
    generatedAt: now.toISOString(),
  };
}

module.exports = { overview };
