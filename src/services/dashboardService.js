'use strict';

const mongoose = require('mongoose');
const { Invoice, Appointment, Patient, Doctor, QueueEntry } = require('../models');
const { dayRange, dateKey } = require('../lib/datetime');
const queueService = require('./queueService');
const branchService = require('./branchService');

/**
 * Dashboard summary (§5 home) — ONE clinic-scoped aggregate for the redesigned dashboard:
 * KPIs (with day-over-day trend + 7-day sparklines), weekly revenue/appointment series,
 * patient gender demographics, a live activity feed, doctor availability, and AI suggestions.
 *
 * TENANT ISOLATION (hard rule 1): aggregations bypass TenantRepository, so every pipeline
 * $matches ctx.clinicId explicitly — a dashboard request can never surface another clinic's data.
 * An optional branchId narrows operational metrics; when absent, metrics span all branches and
 * the live queue falls back to the clinic's primary branch.
 */

const TZ = 'Asia/Kolkata';
const ATTENDED = ['checked_in', 'in_consultation', 'completed'];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function branchMatch(branchId) {
  if (branchId && mongoose.isValidObjectId(branchId)) return { branchId: new mongoose.Types.ObjectId(branchId) };
  return {};
}

/** The last `n` local days (oldest→today), each with its key, label and day bounds. */
function lastDays(n) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const { start, end } = dayRange(d);
    out.push({ key: dateKey(d), label: WEEKDAY[d.getDay()], start, end });
  }
  return out;
}

const round1 = (n) => Math.round(n * 10) / 10;
function pct(today, prev) {
  if (!prev) return today > 0 ? 100 : 0;
  return round1(((today - prev) / prev) * 100);
}

/** Build one KPI: today's value + day-over-day delta (dir/good) + a 7-point sparkline. */
function kpi(series, { goodWhenUp = true } = {}) {
  const today = series[series.length - 1] || 0;
  const prev = series[series.length - 2] || 0;
  const deltaAbs = round1(today - prev);
  const dir = deltaAbs > 0 ? 'up' : deltaAbs < 0 ? 'down' : 'flat';
  const good = dir === 'flat' ? true : goodWhenUp ? dir === 'up' : dir === 'down';
  return { value: today, deltaPct: pct(today, prev), deltaAbs, dir, good, spark: series };
}

async function summary(ctx, { branchId } = {}) {
  const clinicId = ctx.clinicId;
  const bm = branchMatch(branchId);
  const days = lastDays(7);
  const weekStart = days[0].start;
  const weekEnd = days[days.length - 1].end;
  const today = days[days.length - 1];

  const apptMatch = { clinicId, deletedAt: null, scheduledAt: { $gte: weekStart, $lte: weekEnd }, ...bm };
  const invMatch = { clinicId, deletedAt: null, createdAt: { $gte: weekStart, $lte: weekEnd }, ...bm };
  const waitMatch = { clinicId, createdAt: { $gte: weekStart, $lte: weekEnd }, calledAt: { $ne: null }, ...bm };

  const [apptByDay, revByDay, waitByDay, genderAgg, doctorList, doctorTodayAgg, followUpsDue, recentInvoices, recentAppts, recentPatients] =
    await Promise.all([
      Appointment.aggregate([
        { $match: apptMatch },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$scheduledAt', timezone: TZ } },
            count: { $sum: 1 },
            patients: { $addToSet: '$patientId' },
            noShow: { $sum: { $cond: [{ $eq: ['$status', 'no_show'] }, 1, 0] } },
          },
        },
      ]),
      Invoice.aggregate([
        { $match: invMatch },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } }, revenue: { $sum: '$amountPaid' } } },
      ]),
      QueueEntry.aggregate([
        { $match: waitMatch },
        { $project: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } }, waitMs: { $subtract: ['$calledAt', '$createdAt'] } } },
        { $match: { waitMs: { $gte: 0 } } },
        { $group: { _id: '$day', avgWaitMs: { $avg: '$waitMs' } } },
      ]),
      Patient.aggregate([{ $match: { clinicId, deletedAt: null } }, { $group: { _id: '$gender', count: { $sum: 1 } } }]),
      Doctor.find({ clinicId, isActive: true }).sort({ name: 1 }).lean(),
      Appointment.aggregate([
        { $match: { clinicId, deletedAt: null, scheduledAt: { $gte: today.start, $lte: today.end }, ...bm } },
        { $group: { _id: '$doctorId', count: { $sum: 1 }, inConsult: { $sum: { $cond: [{ $eq: ['$status', 'in_consultation'] }, 1, 0] } } } },
      ]),
      Patient.countDocuments({ clinicId, deletedAt: null, followUpAt: { $ne: null, $lte: new Date() } }),
      Invoice.find({ clinicId, deletedAt: null, amountPaid: { $gt: 0 }, ...bm }).sort({ updatedAt: -1 }).limit(4).lean(),
      Appointment.find({ clinicId, deletedAt: null, status: { $in: ['checked_in', 'confirmed', 'completed'] }, ...bm }).sort({ updatedAt: -1 }).limit(6).lean(),
      Patient.find({ clinicId, deletedAt: null }).sort({ createdAt: -1 }).limit(3).lean(),
    ]);

  // --- Bucket the weekly aggregations into aligned 7-day series ---
  const apptMap = Object.fromEntries(apptByDay.map((d) => [d._id, d]));
  const revMap = Object.fromEntries(revByDay.map((d) => [d._id, d.revenue]));
  const waitMap = Object.fromEntries(waitByDay.map((d) => [d._id, Math.round(d.avgWaitMs / 60000)]));

  const patientsSeries = days.map((d) => (apptMap[d.key]?.patients?.length) || 0);
  const apptSeries = days.map((d) => apptMap[d.key]?.count || 0);
  const revenueSeries = days.map((d) => revMap[d.key] || 0);
  const waitSeries = days.map((d) => waitMap[d.key] || 0);
  const noShowSeries = days.map((d) => apptMap[d.key]?.noShow || 0);

  const kpis = {
    patients: kpi(patientsSeries),
    appointments: kpi(apptSeries),
    revenue: kpi(revenueSeries),
    avgWait: kpi(waitSeries, { goodWhenUp: false }),
    noShows: kpi(noShowSeries, { goodWhenUp: false }),
  };

  const weekly = {
    revenue: days.map((d, i) => ({ label: d.label, value: revenueSeries[i] })),
    appointments: days.map((d, i) => ({ label: d.label, value: apptSeries[i] })),
  };

  // --- Demographics ---
  const g = Object.fromEntries(genderAgg.map((x) => [x._id || 'unspecified', x.count]));
  const demographics = {
    total: genderAgg.reduce((s, x) => s + x.count, 0),
    male: g.male || 0,
    female: g.female || 0,
    other: (g.other || 0) + (g.unspecified || 0),
  };

  // --- Doctor availability ---
  const todayByDoctor = Object.fromEntries(doctorTodayAgg.map((d) => [String(d._id), d]));
  const doctors = doctorList.map((doc) => {
    const t = todayByDoctor[String(doc._id)] || { count: 0, inConsult: 0 };
    return {
      id: String(doc._id),
      name: doc.name,
      specialization: doc.specialization || 'General Physician',
      color: doc.color || '#2563eb',
      status: t.inConsult > 0 ? 'in_consultation' : 'available',
      patientsToday: t.count,
      hours: formatHours(doc.availability),
    };
  });

  // --- Live queue (branch-scoped; falls back to the primary branch) ---
  let queue = { nowServing: [], waiting: [], counts: { waiting: 0, serving: 0 } };
  try {
    const bId = branchId && mongoose.isValidObjectId(branchId) ? branchId : (await branchService.getOrCreatePrimaryBranch(ctx))._id;
    queue = await queueService.snapshot(ctx, bId);
  } catch {
    /* queue is best-effort — never fail the whole dashboard on it */
  }

  // --- Today's appointments (denormalized, ready to render) ---
  const specByDoctor = Object.fromEntries(doctorList.map((d) => [String(d._id), d.specialization]));
  const appointments = (await Appointment.find({ clinicId, deletedAt: null, scheduledAt: { $gte: today.start, $lte: today.end }, ...bm })
    .sort({ scheduledAt: 1 })
    .limit(50)
    .lean()).map((a) => ({
      id: String(a._id),
      scheduledAt: a.scheduledAt,
      tokenNumber: a.tokenNumber ?? null,
      patientName: a.patientName || '—',
      doctorName: a.doctorName || '—',
      department: specByDoctor[String(a.doctorId)] || null,
      status: a.status,
      prepaid: !!a.prepaid,
    }));

  // --- Activity feed (merged from real events, newest first) ---
  const activity = buildActivity({ recentInvoices, recentAppts, recentPatients }).slice(0, 8);

  // --- AI suggestions (real, computed; never diagnostic — hard rule 2) ---
  const upcomingToday = appointments.filter((a) => ['booked', 'confirmed'].includes(a.status)).length;
  const suggestions = [];
  if (followUpsDue > 0) suggestions.push({ key: 'followups', tone: 'info', text: `${followUpsDue} patient${followUpsDue > 1 ? 's are' : ' is'} overdue for follow-up`, cta: 'View patients', link: '/dashboard/crm' });
  if (kpis.noShows.value > 0) suggestions.push({ key: 'noshow', tone: 'warning', text: `${kpis.noShows.value} no-show${kpis.noShows.value > 1 ? 's' : ''} today — send reminders`, cta: 'Open queue', link: '/dashboard/queue' });
  if (kpis.revenue.dir !== 'flat') suggestions.push({ key: 'revenue', tone: 'success', text: `Revenue ${kpis.revenue.dir === 'up' ? 'up' : 'down'} ${Math.abs(kpis.revenue.deltaPct)}% vs yesterday`, cta: 'View report', link: '/dashboard/analytics' });
  if (upcomingToday > 0) suggestions.push({ key: 'upcoming', tone: 'info', text: `${upcomingToday} appointment${upcomingToday > 1 ? 's' : ''} still upcoming today`, cta: 'View schedule', link: '/dashboard/appointments' });

  return {
    kpis,
    weekly,
    demographics,
    doctors,
    queue,
    appointments,
    activity,
    ai: { suggestions: suggestions.slice(0, 5) },
    generatedAt: new Date().toISOString(),
  };
}

/** Format a doctor's working window for today from the availability Map (best-effort). */
function formatHours(availability) {
  if (!availability) return '';
  const map = availability instanceof Map ? Object.fromEntries(availability) : availability;
  const now = new Date();
  const keys = [
    ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()],
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()],
    String(now.getDay()),
  ];
  let windows;
  for (const k of keys) if (Array.isArray(map[k]) && map[k].length) { windows = map[k]; break; }
  if (!windows || !windows.length) return '';
  const to12 = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m || 0).padStart(2, '0')} ${ap}`;
  };
  const w = windows[0];
  return `${to12(w.start)} - ${to12(w.end)}`;
}

function buildActivity({ recentInvoices, recentAppts, recentPatients }) {
  const events = [];
  for (const inv of recentInvoices) {
    events.push({ type: 'payment_received', message: `Payment of ₹${(inv.amountPaid || 0).toLocaleString('en-IN')} received`, subject: inv.patientName || '', at: inv.updatedAt || inv.createdAt });
  }
  for (const a of recentAppts) {
    const label = a.status === 'checked_in' ? 'checked in' : a.status === 'completed' ? 'consultation completed' : 'appointment confirmed';
    events.push({ type: a.status, message: `${a.patientName || 'Patient'} ${label}`, subject: a.doctorName || '', at: a.updatedAt || a.createdAt });
  }
  for (const p of recentPatients) {
    events.push({ type: 'patient_registered', message: `New patient registered: ${p.name}`, subject: '', at: p.createdAt });
  }
  return events.sort((x, y) => new Date(y.at) - new Date(x.at));
}

module.exports = { summary };
