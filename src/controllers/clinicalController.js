'use strict';

const asyncHandler = require('../utils/asyncHandler');
const noteService = require('../services/clinicalNoteService');
const labService = require('../services/labRequestService');

// Clinical notes
const listNotes = asyncHandler(async (req, res) => res.json({ items: await noteService.list(req.ctx, { patientId: req.query.patientId }) }));
const createNote = asyncHandler(async (req, res) => res.status(201).json(await noteService.create(req.ctx, req.body)));
const removeNote = asyncHandler(async (req, res) => {
  const d = await noteService.softDelete(req.ctx, req.params.id);
  res.json({ ok: true, id: d._id, deletedAt: d.deletedAt });
});

// Lab requests
const listLabs = asyncHandler(async (req, res) => res.json({ items: await labService.list(req.ctx, { patientId: req.query.patientId }) }));
const createLab = asyncHandler(async (req, res) => res.status(201).json(await labService.create(req.ctx, req.body)));
const setLabStatus = asyncHandler(async (req, res) => res.json(await labService.updateStatus(req.ctx, req.params.id, req.body.status)));
const recordLabResults = asyncHandler(async (req, res) => res.json(await labService.recordResults(req.ctx, req.params.id, req.body)));
const removeLab = asyncHandler(async (req, res) => {
  const d = await labService.softDelete(req.ctx, req.params.id);
  res.json({ ok: true, id: d._id, deletedAt: d.deletedAt });
});

module.exports = { listNotes, createNote, removeNote, listLabs, createLab, setLabStatus, recordLabResults, removeLab };
