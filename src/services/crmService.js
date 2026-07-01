'use strict';

const { Patient, Invoice } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { sendNotification } = require('./notifications');
const notificationService = require('./notificationService');
const AppError = require('../utils/AppError');

/**
 * CRM & retention (§5.13). Answers "where is my revenue leaking?" from the patient
 * roster + invoices. Strictly CLINIC-SCOPED via TenantRepository / clinicId (hard rule 1)
 * — patients belong to the clinic (not a branch), so this is a clinic-wide retention view.
 * Aggregations return counts + de-identified-enough rows (name/phone the clinic already owns).
 */

const DAY = 24 * 3600 * 1000;
const LAPSED_DAYS = 182; // ~6 months
const FOLLOWUP_WINDOW_DAYS = 7;
const BIRTHDAY_WINDOW_DAYS = 30;

function repo(ctx) {
  return tenantRepo(Patient, ctx);
}

function startOfMonth(now) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Days until this patient's next birthday (0..365), or null if no dob. */
function daysToBirthday(dob, now) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  let next = new Date(now.getFullYear(), d.getMonth(), d.getDate());
  // Normalize to date-only "today" for a stable comparison.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (next < today) next = new Date(now.getFullYear() + 1, d.getMonth(), d.getDate());
  return Math.round((next - today) / DAY);
}

/** Top patients by lifetime paid revenue (invoice-based). Clinic-scoped aggregation. */
async function highValue(ctx, limit) {
  const rows = await Invoice.aggregate([
    { $match: { clinicId: ctx.clinicId, deletedAt: null } },
    { $group: { _id: '$patientId', revenue: { $sum: '$amountPaid' } } },
    { $match: { revenue: { $gt: 0 } } },
    { $sort: { revenue: -1 } },
    { $limit: limit },
  ]);
  if (!rows.length) return [];
  const ids = rows.map((r) => r._id).filter(Boolean);
  const patients = await repo(ctx).find({ _id: { $in: ids } }, { lean: true });
  const byId = new Map(patients.map((p) => [String(p._id), p]));
  return rows
    .map((r) => {
      const p = byId.get(String(r._id));
      return p ? { _id: p._id, name: p.name, phone: p.phone, revenue: r.revenue, visitCount: p.visitCount } : null;
    })
    .filter(Boolean);
}

/** Build the filter for a named retention segment. */
function segmentFilter(key, now) {
  switch (key) {
    case 'lapsed':
      return { lastVisitAt: { $ne: null, $lt: new Date(now - LAPSED_DAYS * DAY) } };
    case 'repeat':
      return { visitCount: { $gte: 2 } };
    case 'followups_due':
      return { followUpAt: { $ne: null, $lte: new Date(now.getTime() + FOLLOWUP_WINDOW_DAYS * DAY) } };
    case 'new_this_month':
      return { createdAt: { $gte: startOfMonth(now) } };
    default:
      return null;
  }
}

async function summary(ctx, now = new Date()) {
  const r = repo(ctx);
  const [lapsed, repeat, followupsDue, newThisMonth, withDob, hv] = await Promise.all([
    r.count(segmentFilter('lapsed', now)),
    r.count(segmentFilter('repeat', now)),
    r.count(segmentFilter('followups_due', now)),
    r.count(segmentFilter('new_this_month', now)),
    r.find({ dob: { $ne: null } }, { projection: { dob: 1 }, lean: true }),
    highValue(ctx, 5),
  ]);
  const birthdays = withDob.filter((p) => {
    const d = daysToBirthday(p.dob, now);
    return d !== null && d <= BIRTHDAY_WINDOW_DAYS;
  }).length;

  return {
    counts: { lapsed, repeat, highValue: hv.length, birthdays, followupsDue, newThisMonth },
    highValue: hv,
    generatedAt: now.toISOString(),
  };
}

/** List the patients in a retention segment (for the drill-down table). */
async function segment(ctx, key, { limit = 100 } = {}, now = new Date()) {
  if (key === 'high_value') return highValue(ctx, limit);
  if (key === 'birthdays') {
    const withDob = await repo(ctx).find({ dob: { $ne: null } }, { lean: true });
    return withDob
      .map((p) => ({ ...p, daysToBirthday: daysToBirthday(p.dob, now) }))
      .filter((p) => p.daysToBirthday !== null && p.daysToBirthday <= BIRTHDAY_WINDOW_DAYS)
      .sort((a, b) => a.daysToBirthday - b.daysToBirthday)
      .slice(0, limit)
      .map((p) => ({ _id: p._id, name: p.name, phone: p.phone, dob: p.dob, daysToBirthday: p.daysToBirthday }));
  }
  const filter = segmentFilter(key, now);
  if (!filter) throw new AppError(400, 'Unknown CRM segment');
  const patients = await repo(ctx).find(filter, { sort: { lastVisitAt: 1 }, limit, lean: true });
  return patients.map((p) => ({ _id: p._id, name: p.name, phone: p.phone, email: p.email, lastVisitAt: p.lastVisitAt, visitCount: p.visitCount, followUpAt: p.followUpAt }));
}

/**
 * Re-engage a lapsed patient: send an email via the provider-agnostic notification
 * service + drop an in-app note. Clinic-scoped (ownership enforced by the tenant repo).
 * This is a marketing touch, never medical advice.
 */
async function reengage(ctx, patientId) {
  const patient = await repo(ctx).findById(patientId);
  if (!patient) throw new AppError(404, 'Patient not found');
  if (!patient.email) throw new AppError(400, 'This patient has no email on file to contact.');

  const clinicName = ctx.clinicName || 'your clinic';
  await sendNotification({
    channel: 'email',
    to: patient.email,
    subject: `We'd love to see you again at ${clinicName}`,
    message: `Hi ${patient.name || 'there'}, it's been a while since your last visit. If you're due for a check-up or follow-up, we're here to help — reply or call to book a convenient time.`,
  });
  notificationService.emit(ctx, { type: 'other', message: `Re-engagement message sent to ${patient.name}`, link: '/crm' }).catch(() => {});
  return { ok: true, patientId: String(patient._id), channel: 'email' };
}

module.exports = { summary, segment, reengage };
