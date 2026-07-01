'use strict';

const { Appointment, Prescription, Report, ClinicalNote, Reminder } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');

/**
 * Patient timeline (§5.12) — merges appointments, prescriptions, reports, clinical
 * notes, and reminders for one patient into a single chronological list. All reads
 * go through the tenant repo, so soft-deleted docs are excluded automatically and
 * everything is clinic-scoped (hard rules 1 + 6).
 */
async function getTimeline(ctx, patientId) {
  const [appts, rx, reports, notes, reminders] = await Promise.all([
    tenantRepo(Appointment, ctx).find({ patientId }, { lean: true }),
    tenantRepo(Prescription, ctx).find({ patientId }, { lean: true }),
    tenantRepo(Report, ctx).find({ patientId }, { lean: true }),
    tenantRepo(ClinicalNote, ctx).find({ patientId }, { lean: true }),
    tenantRepo(Reminder, ctx, { audit: false }).find({ patientId }, { lean: true }),
  ]);

  const items = [];
  appts.forEach((a) => items.push({ type: 'appointment', date: a.scheduledAt, title: `Appointment — ${a.doctorName || 'doctor'}`, status: a.status, id: String(a._id) }));
  rx.forEach((p) => items.push({ type: 'prescription', date: p.createdAt, title: `Prescription${p.diagnosis ? ` — ${p.diagnosis}` : ''}`, meta: `${p.items?.length || 0} medicine(s)`, id: String(p._id) }));
  reports.forEach((r) => items.push({ type: 'report', date: r.createdAt, title: `Report — ${r.title || r.type}`, id: String(r._id) }));
  notes.forEach((n) => items.push({ type: 'note', date: n.createdAt, title: 'Clinical note', meta: (n.content || '').slice(0, 90), id: String(n._id) }));
  reminders.forEach((rm) => items.push({ type: 'reminder', date: rm.sentAt || rm.sendAt, title: `Reminder · ${rm.type}`, meta: rm.status, id: String(rm._id) }));

  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return items;
}

module.exports = { getTimeline };
