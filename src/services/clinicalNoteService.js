'use strict';

const { ClinicalNote, Doctor } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const branchService = require('./branchService');
const AppError = require('../utils/AppError');

function repo(ctx) {
  return tenantRepo(ClinicalNote, ctx); // audited (clinical)
}

async function create(ctx, { patientId, appointmentId, doctorId, content }) {
  if (!patientId) throw new AppError(400, 'patientId is required');
  if (!content || !content.trim()) throw new AppError(400, 'Note content is required');
  let doctorName;
  if (doctorId) doctorName = (await tenantRepo(Doctor, ctx).findById(doctorId))?.name;
  const branch = await branchService.getOrCreatePrimaryBranch(ctx);
  return repo(ctx).create({ patientId, appointmentId: appointmentId || undefined, doctorId: doctorId || undefined, doctorName, content, branchId: branch._id });
}

function list(ctx, { patientId } = {}) {
  const filter = {};
  if (patientId) filter.patientId = patientId;
  return repo(ctx).find(filter, { sort: { createdAt: -1 }, lean: true });
}

async function softDelete(ctx, id) {
  const d = await repo(ctx).softDeleteById(id);
  if (!d) throw new AppError(404, 'Note not found');
  return d;
}

module.exports = { create, list, softDelete };
