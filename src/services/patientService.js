'use strict';

const { Patient, Appointment } = require('../models');
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
  return { items, total, limit, skip };
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

/**
 * Exact-match patient lookup by contact, for find-or-create flows (public booking,
 * walk-in). Uses exact email/phone equality — NOT the fuzzy receptionist search —
 * so a booking can never be grafted onto an unrelated patient via a substring match.
 */
async function findByContact(ctx, { email, phone } = {}) {
  const repo = tenantRepo(Patient, ctx);
  const e = email ? String(email).toLowerCase().trim() : null;
  if (e) {
    const m = await repo.findOne({ email: e });
    if (m) return m;
  }
  const p = phone ? String(phone).trim() : null;
  if (p) {
    const m = await repo.findOne({ phone: p });
    if (m) return m;
  }
  return null;
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
  findByContact,
  getPatientVisits,
  getPatientDetail,
};
