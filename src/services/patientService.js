'use strict';

const { Patient, Appointment, Invoice } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { nextSequence } = require('../lib/sequence');
const AppError = require('../utils/AppError');

/**
 * Patient service — the REFERENCE example for every future feature.
 *
 * It NEVER touches the Patient model directly: all data access goes through
 * tenantRepo(Patient, ctx), so it gets, for free:
 *   - clinicId scoping        (hard rule 1)
 *   - soft-delete exclusion   (hard rule 6)
 *   - audit logging on writes (hard rule 7)
 *
 * Copy this shape for new features. Do not reach around the repository.
 */

// Mass-assignment guard: only these fields are client-settable in Phase 0.
// visitCount/lastVisitAt are system-managed (updated by the appointment flow in Phase 1).
const WRITABLE_FIELDS = [
  'name',
  'phone',
  'email',
  'dob',
  'gender',
  'notes',
  'bloodGroup',
  'medicalHistory',
  'allergies',
  'currentMedications',
  'emergencyContact',
  'insurance',
  'tags',
  'followUpAt', // doctor/owner sets the next recommended follow-up (CRM)
];

function pickWritable(data = {}) {
  const out = {};
  for (const key of WRITABLE_FIELDS) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

/**
 * Generate a per-clinic patient code (P00001, P00002, ...) from an ATOMIC
 * counter — race-safe and monotonic, so concurrent receptionists never collide
 * and a code is never reused. patientCode is fully system-generated in Phase 0
 * (clients cannot supply one), so the counter can never desync from existing data.
 */
async function generatePatientCode(clinicId) {
  const seq = await nextSequence(clinicId, 'patientCode');
  return `P${String(seq).padStart(5, '0')}`;
}

async function listPatients(ctx, { search, limit = 50, skip = 0, includeDeleted = false } = {}) {
  const repo = tenantRepo(Patient, ctx);
  const filter = {};
  if (search && search.trim()) {
    const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { phone: rx }, { patientCode: rx }];
  }
  const [items, total] = await Promise.all([
    repo.find(filter, { sort: { createdAt: -1 }, limit: Math.min(limit, 200), skip, lean: true, includeDeleted }),
    repo.count(filter, { includeDeleted }),
  ]);
  await attachBalances(ctx, items);
  return { items, total, limit, skip };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Attach each patient's outstanding balance (sum of unpaid/partially-paid invoices) — the
 * front desk's most-wanted number. One batched invoices query, grouped in memory (no N+1).
 */
async function attachBalances(ctx, patients) {
  if (!patients.length) return patients;
  const ids = patients.map((p) => p._id);
  const invoices = await tenantRepo(Invoice, ctx, { audit: false }).find(
    { patientId: { $in: ids }, status: { $in: ['unpaid', 'partially_paid'] } },
    { projection: { patientId: 1, total: 1, amountPaid: 1 }, lean: true }
  );
  const dueByPatient = new Map();
  for (const inv of invoices) {
    const k = String(inv.patientId);
    dueByPatient.set(k, round2((dueByPatient.get(k) || 0) + ((inv.total || 0) - (inv.amountPaid || 0))));
  }
  for (const p of patients) p.balanceDue = Math.max(0, dueByPatient.get(String(p._id)) || 0);
  return patients;
}

async function getPatient(ctx, id) {
  const repo = tenantRepo(Patient, ctx);
  const patient = await repo.findById(id);
  if (!patient) throw new AppError(404, 'Patient not found');
  return patient;
}

async function createPatient(ctx, data) {
  const repo = tenantRepo(Patient, ctx);
  const payload = pickWritable(data);
  if (!payload.name) throw new AppError(400, 'Patient name is required');

  // patientCode is system-generated from an atomic counter. The 11000 retry is a
  // last-resort guard (e.g. a counter seeded behind migrated data); each retry
  // calls nextSequence again, so it actually advances rather than spinning.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const patientCode = await generatePatientCode(ctx.clinicId);
    try {
      return await repo.create({ ...payload, patientCode });
    } catch (err) {
      if (err.code === 11000 && attempt < 4) continue;
      if (err.code === 11000) throw new AppError(409, 'Could not allocate a unique patientCode');
      throw err;
    }
  }
}

async function updatePatient(ctx, id, data) {
  const repo = tenantRepo(Patient, ctx);
  const updated = await repo.updateById(id, pickWritable(data));
  if (!updated) throw new AppError(404, 'Patient not found');
  return updated;
}

async function softDeletePatient(ctx, id) {
  const repo = tenantRepo(Patient, ctx);
  const deleted = await repo.softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Patient not found');
  return deleted;
}

/** Recently-deleted patients (owner "trash" view) — so a mis-deletion is visible and undoable. */
function listDeletedPatients(ctx, { limit = 100 } = {}) {
  return tenantRepo(Patient, ctx).listDeleted({}, { limit });
}

/** Restore a soft-deleted patient (owner-only undo). */
async function restorePatient(ctx, id) {
  const restored = await tenantRepo(Patient, ctx).restoreById(id);
  if (!restored) throw new AppError(404, 'No deleted patient found to restore');
  return restored;
}

const phoneTail = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/** Same underlying person? Tolerant so a typo/short form ("Rahul" vs "Rahul Sharma") isn't split,
 * but two clearly different names on ONE contact ARE treated as different people. */
function sameName(a, b) {
  const na = String(a || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const nb = String(b || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!na || !nb) return true; // can't tell → don't split
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

/**
 * Match a patient by contact for find-or-create flows (public booking, walk-in). Email is exact;
 * phone matches on the normalized last-10-digits SUFFIX, so "+91 90000-00001", "090000 00001" and
 * "9000000001" resolve to the same patient (reduces duplicate records from format variations).
 * A phone shorter than 10 digits never matches — preserving "never a substring hijack".
 */
async function findByContact(ctx, { email, phone } = {}) {
  const repo = tenantRepo(Patient, ctx);
  const e = email ? String(email).toLowerCase().trim() : null;
  if (e) {
    const m = await repo.findOne({ email: e });
    if (m) return m;
  }
  const tail = phoneTail(phone);
  if (tail.length >= 10) {
    const m = await repo.findOne({ phone: { $regex: `${tail}$` } });
    if (m) return m;
  }
  return null;
}

/**
 * Find-or-create a patient for a booking/walk-in with family-safety. Reuses an existing patient
 * matched by contact ONLY when the name is consistent. When the SAME phone/email is used for a
 * clearly DIFFERENT person — the Indian shared-household-number norm (a parent booking for a
 * child) — a distinct record is created instead, so two people's clinical histories never merge
 * onto one chart. Returns { patient, created, reused, sharedContactWith? }.
 */
async function findOrCreatePatient(ctx, { name, phone, email } = {}) {
  const match = await findByContact(ctx, { email, phone });
  if (match && sameName(match.name, name)) return { patient: match, created: false, reused: true };
  if (!name) {
    if (match) return { patient: match, created: false, reused: true }; // no name to compare → reuse
    throw new AppError(400, 'Patient name (or an existing patient) is required');
  }
  const created = await createPatient(ctx, { name, phone, email });
  return { patient: created, created: true, ...(match ? { sharedContactWith: String(match._id) } : {}) };
}

/** A patient's appointment/visit history (newest first) — powers the detail panel. */
async function getPatientVisits(ctx, patientId, { limit = 25 } = {}) {
  return tenantRepo(Appointment, ctx).find({ patientId }, { sort: { scheduledAt: -1 }, limit, lean: true });
}

/** Patient record + visit history for the detail panel (step 2). */
async function getPatientDetail(ctx, id) {
  const patient = await getPatient(ctx, id);
  const visits = await getPatientVisits(ctx, id);
  return { patient, visits };
}

module.exports = {
  listPatients,
  getPatient,
  createPatient,
  updatePatient,
  softDeletePatient,
  listDeletedPatients,
  restorePatient,
  findByContact,
  findOrCreatePatient,
  getPatientVisits,
  getPatientDetail,
};
