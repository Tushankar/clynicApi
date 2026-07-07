'use strict';

const { LabRequest, Patient } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const branchService = require('./branchService');
const notificationService = require('./notificationService');
const AppError = require('../utils/AppError');

function repo(ctx) {
  return tenantRepo(LabRequest, ctx); // audited (clinical)
}

async function create(ctx, { patientId, appointmentId, doctorId, tests, notes }) {
  if (!patientId) throw new AppError(400, 'patientId is required');
  const arr = (Array.isArray(tests) ? tests : []).map((t) => String(t).trim()).filter(Boolean);
  if (arr.length === 0) throw new AppError(400, 'At least one test is required');

  const patient = await tenantRepo(Patient, ctx).findById(patientId);
  const branch = await branchService.getOrCreatePrimaryBranch(ctx);
  const created = await repo(ctx).create({
    patientId,
    appointmentId: appointmentId || undefined,
    doctorId: doctorId || undefined,
    patientName: patient?.name,
    tests: arr,
    notes,
    branchId: branch._id,
  });

  notificationService
    .emit(ctx, { type: 'lab_request_created', message: `Lab tests requested for ${patient?.name || 'a patient'}`, link: `/patients/${patientId}` })
    .catch(() => {});
  return created;
}

function list(ctx, { patientId } = {}) {
  const filter = {};
  if (patientId) filter.patientId = patientId;
  return repo(ctx).find(filter, { sort: { createdAt: -1 }, lean: true });
}

async function updateStatus(ctx, id, status) {
  const d = await repo(ctx).updateById(id, { status });
  if (!d) throw new AppError(404, 'Lab request not found');
  // Results ready is a state the ordering doctor / desk needs to see — previously silent.
  if (status === 'completed') {
    notificationService
      .emit(ctx, { type: 'lab_request_completed', message: `Lab results are in for ${d.patientName || 'a patient'}`, link: d.patientId ? `/patients/${d.patientId}` : '/dashboard' })
      .catch(() => {});
  }
  return d;
}

/**
 * Record results against a lab order and (by default) mark it completed — the piece that closes the
 * order → collect → result loop. Accepts structured rows and/or an interpretation note, plus an
 * optional linked report file (resultReportId).
 */
async function recordResults(ctx, id, { results, resultNotes, resultReportId, complete = true } = {}) {
  const clean = (Array.isArray(results) ? results : [])
    .map((r) => ({
      test: String(r.test || '').trim(),
      value: String(r.value ?? '').trim(),
      unit: String(r.unit || '').trim(),
      refRange: String(r.refRange || '').trim(),
      flag: ['normal', 'low', 'high', 'abnormal'].includes(r.flag) ? r.flag : '',
    }))
    .filter((r) => r.value !== ''); // only persist tests that actually have a result value

  const patch = {
    results: clean,
    resultNotes: String(resultNotes || '').trim(),
    resultReportId: resultReportId || null,
    resultedAt: new Date(),
    resultedBy: ctx.actorId || null,
  };
  if (complete) patch.status = 'completed';

  const d = await repo(ctx).updateById(id, patch);
  if (!d) throw new AppError(404, 'Lab request not found');
  if (patch.status === 'completed') {
    notificationService
      .emit(ctx, { type: 'lab_request_completed', message: `Lab results are in for ${d.patientName || 'a patient'}`, link: d.patientId ? `/patients/${d.patientId}` : '/dashboard' })
      .catch(() => {});
  }
  return d;
}

async function softDelete(ctx, id) {
  const d = await repo(ctx).softDeleteById(id);
  if (!d) throw new AppError(404, 'Lab request not found');
  return d;
}

module.exports = { create, list, updateStatus, recordResults, softDelete };
