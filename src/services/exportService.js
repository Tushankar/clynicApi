'use strict';

const { Patient, Appointment, Invoice, Expense, Prescription, ClinicalNote, LabRequest, Report } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const AppError = require('../utils/AppError');

/**
 * CSV data export (§5.23, DATA_EXPORT) — "my data isn't hostage". Owner-only at the
 * route. Everything flows through the tenant repo (clinic-scoped, soft-deletes
 * excluded); output is UTF-8 with BOM so Excel opens ₹ and names correctly.
 */

const MAX_ROWS = 20000;

const esc = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const iso = (d) => (d ? new Date(d).toISOString() : '');
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function toCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(row.map(esc).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

function rangeFilter(field, { from, to }) {
  if (!from && !to) return {};
  const f = {};
  if (from) f.$gte = new Date(from);
  if (to) f.$lte = new Date(to);
  return { [field]: f };
}

const ENTITIES = {
  patients: {
    fetch: (ctx, range) =>
      tenantRepo(Patient, ctx, { audit: false }).find(rangeFilter('createdAt', range), { sort: { createdAt: -1 }, limit: MAX_ROWS, lean: true }),
    headers: ['Patient code', 'Name', 'Phone', 'Email', 'Gender', 'Date of birth', 'Visits', 'Last visit', 'Follow-up due', 'Tags', 'Registered'],
    row: (p) => [p.patientCode, p.name, p.phone, p.email, p.gender, day(p.dob), p.visitCount || 0, iso(p.lastVisitAt), iso(p.followUpAt), (p.tags || []).join('; '), iso(p.createdAt)],
  },
  appointments: {
    fetch: (ctx, range) =>
      tenantRepo(Appointment, ctx, { audit: false }).find(rangeFilter('scheduledAt', range), { sort: { scheduledAt: -1 }, limit: MAX_ROWS, lean: true }),
    headers: ['Scheduled at', 'Patient', 'Phone', 'Doctor', 'Status', 'Source', 'Token', 'Duration (min)', 'Prepaid', 'Reason', 'Booked at'],
    row: (a) => [iso(a.scheduledAt), a.patientName, a.patientPhone, a.doctorName, a.status, a.source, a.tokenNumber ?? '', a.durationMinutes || '', a.prepaid ? 'yes' : 'no', a.reason, iso(a.createdAt)],
  },
  invoices: {
    fetch: (ctx, range) =>
      tenantRepo(Invoice, ctx, { audit: false }).find(rangeFilter('createdAt', range), { sort: { createdAt: -1 }, limit: MAX_ROWS, lean: true }),
    headers: ['Invoice', 'Patient', 'Subtotal', 'GST %', 'GST amount', 'Total', 'Paid', 'Refunded', 'Balance', 'Status', 'Date'],
    row: (i) => [i.invoiceNumber, i.patientName, i.subtotal, i.gstRate, i.gstAmount, i.total, i.amountPaid, i.amountRefunded, Math.max(0, Math.round((i.total - i.amountPaid) * 100) / 100), i.status, iso(i.createdAt)],
  },
  expenses: {
    fetch: (ctx, range) =>
      tenantRepo(Expense, ctx, { audit: false }).find(rangeFilter('date', range), { sort: { date: -1 }, limit: MAX_ROWS, lean: true }),
    headers: ['Date', 'Category', 'Description', 'Amount', 'Method', 'Note'],
    row: (e) => [day(e.date), e.category, e.description, e.amount, e.method, e.note],
  },
  // The actual MEDICAL RECORD (previously excluded from "export my data", which left prescriptions,
  // notes and lab/report data hostage). Prescription/lab items are flattened to a readable cell.
  prescriptions: {
    fetch: (ctx, range) =>
      tenantRepo(Prescription, ctx, { audit: false }).find(rangeFilter('createdAt', range), { sort: { createdAt: -1 }, limit: MAX_ROWS, lean: true }),
    headers: ['Date', 'Patient', 'Doctor', 'Diagnosis', 'Medicines', 'Notes'],
    row: (p) => [
      iso(p.createdAt), p.patientName, p.doctorName, p.diagnosis,
      (p.items || []).map((it) => [it.drug, it.dose, it.frequency, it.duration].filter(Boolean).join(' ')).join('; '),
      p.notes,
    ],
  },
  clinical_notes: {
    fetch: (ctx, range) =>
      tenantRepo(ClinicalNote, ctx, { audit: false }).find(rangeFilter('createdAt', range), { sort: { createdAt: -1 }, limit: MAX_ROWS, lean: true }),
    headers: ['Date', 'Patient', 'Doctor', 'Note'],
    row: (n) => [iso(n.createdAt), String(n.patientId || ''), n.doctorName, n.content],
  },
  lab_requests: {
    fetch: (ctx, range) =>
      tenantRepo(LabRequest, ctx, { audit: false }).find(rangeFilter('createdAt', range), { sort: { createdAt: -1 }, limit: MAX_ROWS, lean: true }),
    headers: ['Date', 'Patient', 'Tests', 'Status', 'Notes'],
    row: (l) => [iso(l.createdAt), l.patientName, (l.tests || []).join('; '), l.status, l.notes],
  },
  // File MANIFEST (metadata, not the bytes) — so an export names every uploaded report. The bytes
  // themselves come from the storage bucket / backup; this proves nothing is silently left behind.
  reports: {
    fetch: (ctx, range) =>
      tenantRepo(Report, ctx, { audit: false }).find(rangeFilter('createdAt', range), { sort: { createdAt: -1 }, limit: MAX_ROWS, lean: true }),
    headers: ['Date', 'Patient', 'Type', 'Title', 'Original file', 'MIME', 'Size (bytes)', 'Storage key'],
    row: (r) => [iso(r.createdAt), String(r.patientId || ''), r.type, r.title, r.originalName, r.mimeType, r.size || '', r.storageKey],
  },
};

async function exportCsv(ctx, entity, { from, to } = {}) {
  const def = ENTITIES[entity];
  if (!def) throw new AppError(400, `Unknown export: ${entity}. Use one of ${Object.keys(ENTITIES).join(', ')}.`);
  const docs = await def.fetch(ctx, { from, to });
  return { filename: `${entity}-${day(new Date())}.csv`, csv: toCsv(def.headers, docs.map(def.row)) };
}

module.exports = { exportCsv, ENTITIES: Object.keys(ENTITIES) };
