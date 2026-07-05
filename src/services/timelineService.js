'use strict';

const { Appointment, Prescription, Report, ClinicalNote, Reminder, LabRequest, Dispense, MedicineOrder } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');

/**
 * Patient timeline (§5.12) — merges appointments, prescriptions, reports, clinical notes,
 * lab requests, and reminders for one patient into a single chronological list. All reads go
 * through the tenant repo, so soft-deleted docs are excluded automatically and everything is
 * clinic-scoped (hard rules 1 + 6). Lab requests were previously missing here, so an ordered-
 * but-pending test dropped out of the history a returning doctor scans.
 */
async function getTimeline(ctx, patientId, { includePharmacy = false } = {}) {
  const [appts, rx, reports, notes, reminders, labs, dispenses, orders] = await Promise.all([
    tenantRepo(Appointment, ctx).find({ patientId }, { lean: true }),
    tenantRepo(Prescription, ctx).find({ patientId }, { lean: true }),
    tenantRepo(Report, ctx).find({ patientId }, { lean: true }),
    tenantRepo(ClinicalNote, ctx).find({ patientId }, { lean: true }),
    tenantRepo(Reminder, ctx, { audit: false }).find({ patientId }, { lean: true }),
    tenantRepo(LabRequest, ctx).find({ patientId }, { lean: true }),
    // Pharmacy dispenses + store orders join the timeline ONLY for Ultra clinics (feature-gated
    // branch, §4.5.1). Non-Ultra clinics never run these queries, so their timeline is byte-for-byte unchanged.
    includePharmacy ? tenantRepo(Dispense, ctx).find({ patientId }, { lean: true }) : Promise.resolve([]),
    includePharmacy ? tenantRepo(MedicineOrder, ctx).find({ patientId }, { lean: true }) : Promise.resolve([]),
  ]);

  const items = [];
  appts.forEach((a) => items.push({ type: 'appointment', date: a.scheduledAt, title: `Appointment — ${a.doctorName || 'doctor'}`, status: a.status, id: String(a._id) }));
  rx.forEach((p) => items.push({ type: 'prescription', date: p.createdAt, title: `Prescription${p.diagnosis ? ` — ${p.diagnosis}` : ''}`, meta: `${p.items?.length || 0} medicine(s)`, id: String(p._id) }));
  reports.forEach((r) => items.push({ type: 'report', date: r.createdAt, title: `Report — ${r.title || r.type}`, id: String(r._id) }));
  notes.forEach((n) => items.push({ type: 'note', date: n.createdAt, title: 'Clinical note', meta: (n.content || '').slice(0, 90), id: String(n._id) }));
  labs.forEach((l) => items.push({ type: 'lab', date: l.createdAt, title: `Lab — ${(l.tests || []).join(', ') || 'requested'}`, status: l.status, meta: l.status, id: String(l._id) }));
  reminders.forEach((rm) => items.push({ type: 'reminder', date: rm.sentAt || rm.sendAt, title: `Reminder · ${rm.type}`, meta: rm.status, id: String(rm._id) }));
  dispenses.forEach((d) => items.push({ type: 'dispense', date: d.dispensedAt || d.createdAt, title: `Dispensed at pharmacy — ${d.items?.length || 0} medicine(s)`, meta: d.total ? `₹${Number(d.total).toLocaleString('en-IN')}` : undefined, id: String(d._id) }));
  orders.forEach((o) => items.push({ type: 'order', date: o.createdAt, title: `Store order ${o.orderNumber || ''} — ${o.items?.length || 0} item(s)`, status: o.status, meta: `${o.status}${o.total ? ` · ₹${Number(o.total).toLocaleString('en-IN')}` : ''}`, id: String(o._id) }));

  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return items;
}

module.exports = { getTimeline };
