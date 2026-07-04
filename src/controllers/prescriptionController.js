'use strict';

const asyncHandler = require('../utils/asyncHandler');
const prescriptionService = require('../services/prescriptionService');

const list = asyncHandler(async (req, res) => {
  res.json({ items: await prescriptionService.list(req.ctx, { patientId: req.query.patientId, appointmentId: req.query.appointmentId }) });
});
const get = asyncHandler(async (req, res) => res.json(await prescriptionService.getById(req.ctx, req.params.id)));
const create = asyncHandler(async (req, res) => res.status(201).json(await prescriptionService.create(req.ctx, req.body)));
const remove = asyncHandler(async (req, res) => {
  const d = await prescriptionService.softDelete(req.ctx, req.params.id);
  res.json({ ok: true, id: d._id, deletedAt: d.deletedAt, deletedBy: d.deletedBy });
});

// Share the prescription with the patient as a tokenized view/download link (§5.23).
const share = asyncHandler(async (req, res) => {
  res.json(await require('../services/shareService').shareDocument(req.ctx, { kind: 'prescription', id: req.params.id }));
});

module.exports = { list, get, create, remove, share };
