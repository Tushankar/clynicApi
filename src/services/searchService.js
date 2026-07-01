'use strict';

const { Patient, Appointment } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');

/**
 * Gmail-style universal search (§5.15). Tenant-scoped (via the repo) regex match
 * across patient name / phone / code / notes / medical history / allergies, plus
 * recent appointments by patient or doctor name. Results are grouped.
 */
function rx(q) {
  return new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

async function search(ctx, q) {
  if (!q || !q.trim()) return { patients: [], appointments: [], query: '' };
  const r = rx(q);

  const [patients, appointments] = await Promise.all([
    tenantRepo(Patient, ctx).find(
      { $or: [{ name: r }, { phone: r }, { patientCode: r }, { notes: r }, { medicalHistory: r }, { allergies: r }] },
      { sort: { lastVisitAt: -1 }, limit: 20, lean: true }
    ),
    tenantRepo(Appointment, ctx).find(
      { $or: [{ patientName: r }, { doctorName: r }] },
      { sort: { scheduledAt: -1 }, limit: 10, lean: true }
    ),
  ]);

  return { query: q, patients, appointments };
}

module.exports = { search };
