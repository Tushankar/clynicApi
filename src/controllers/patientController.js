'use strict';

const patientService = require('../services/patientService');
const timelineService = require('../services/timelineService');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

/**
 * Patient controllers. Thin HTTP layer — all tenant rules live in the service +
 * tenant repository. req.ctx is supplied by attachAuthContext.
 */

const list = asyncHandler(async (req, res) => {
  const { search, limit, skip, includeDeleted } = req.query;
  const wantsDeleted = includeDeleted === 'true';
  // Viewing soft-deleted patients is OWNER-ONLY (hard rules 4 + 6). A non-owner
  // who explicitly asks for them gets an explicit 403, not a silently filtered list.
  if (wantsDeleted && req.auth?.role !== 'owner') {
    throw new AppError(403, 'Only an owner can view deleted patients');
  }
  const result = await patientService.listPatients(req.ctx, {
    search,
    limit: limit ? Number(limit) : undefined,
    skip: skip ? Number(skip) : undefined,
    includeDeleted: wantsDeleted,
  });
  res.json(result);
});

const get = asyncHandler(async (req, res) => {
  const patient = await patientService.getPatient(req.ctx, req.params.id);
  res.json(patient);
});

// Patient record + visit history for the detail panel (step 2).
const detail = asyncHandler(async (req, res) => {
  res.json(await patientService.getPatientDetail(req.ctx, req.params.id));
});

// Patient timeline (Phase 2, plan-gated at the route).
const timeline = asyncHandler(async (req, res) => {
  res.json({ items: await timelineService.getTimeline(req.ctx, req.params.id) });
});

const create = asyncHandler(async (req, res) => {
  const patient = await patientService.createPatient(req.ctx, req.body);
  res.status(201).json(patient);
});

const update = asyncHandler(async (req, res) => {
  const patient = await patientService.updatePatient(req.ctx, req.params.id, req.body);
  res.json(patient);
});

const remove = asyncHandler(async (req, res) => {
  const patient = await patientService.softDeletePatient(req.ctx, req.params.id);
  res.json({ ok: true, id: patient._id, deletedAt: patient.deletedAt, deletedBy: patient.deletedBy });
});

// Owner-only recovery: list recently-deleted patients + restore one (undo a mis-deletion).
const listDeleted = asyncHandler(async (req, res) => {
  res.json({ items: await patientService.listDeletedPatients(req.ctx, {}) });
});
const restore = asyncHandler(async (req, res) => {
  res.json(await patientService.restorePatient(req.ctx, req.params.id));
});

module.exports = { list, get, detail, timeline, create, update, remove, listDeleted, restore };
