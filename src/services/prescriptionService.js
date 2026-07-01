'use strict';

const { Prescription, Patient, Doctor } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const branchService = require('./branchService');
const AppError = require('../utils/AppError');

function repo(ctx) {
  return tenantRepo(Prescription, ctx); // audited (clinical data — hard rule 7)
}

async function create(ctx, data) {
  const { patientId, doctorId, appointmentId, items = [], notes, diagnosis } = data;
  const patient = await tenantRepo(Patient, ctx).findById(patientId);
  if (!patient) throw new AppError(404, 'Patient not found');
  const doctor = await tenantRepo(Doctor, ctx).findById(doctorId);
  if (!doctor) throw new AppError(404, 'Doctor not found');

  const cleanItems = items.filter((it) => it && it.drug && it.drug.trim());
  if (cleanItems.length === 0) throw new AppError(400, 'At least one prescription item (drug) is required');

  const branch = await branchService.getOrCreatePrimaryBranch(ctx);
  const created = await repo(ctx).create({
    patientId,
    doctorId,
    appointmentId: appointmentId || undefined,
    branchId: branch._id,
    patientName: patient.name,
    doctorName: doctor.name,
    items: cleanItems,
    notes,
    diagnosis,
  });

  // Notification center event (step 10) — no-op until wired.
  require('./notificationService').emit(ctx, {
    type: 'prescription_created',
    message: `Prescription issued for ${patient.name} by ${doctor.name}`,
    link: `/patients/${patientId}`,
  }).catch(() => {});

  return created;
}

function list(ctx, { patientId, appointmentId } = {}) {
  const filter = {};
  if (patientId) filter.patientId = patientId;
  if (appointmentId) filter.appointmentId = appointmentId;
  return repo(ctx).find(filter, { sort: { createdAt: -1 }, lean: true });
}

async function getById(ctx, id) {
  const doc = await repo(ctx).findById(id);
  if (!doc) throw new AppError(404, 'Prescription not found');
  return doc;
}

async function softDelete(ctx, id) {
  const deleted = await repo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Prescription not found');
  return deleted;
}

module.exports = { create, list, getById, softDelete };
