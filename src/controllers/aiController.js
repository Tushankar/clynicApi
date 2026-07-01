'use strict';

const asyncHandler = require('../utils/asyncHandler');
const aiService = require('../services/aiService');

const faq = asyncHandler(async (req, res) => {
  res.json(await aiService.faq(req.ctx, req.clinic || {}, req.body.question));
});

const symptomIntake = asyncHandler(async (req, res) => {
  res.status(201).json(await aiService.symptomIntake(req.ctx, { patientId: req.body.patientId, appointmentId: req.body.appointmentId, symptomsText: req.body.symptomsText }));
});

const visitSummary = asyncHandler(async (req, res) => {
  res.status(201).json(await aiService.visitSummaryDraft(req.ctx, { patientId: req.body.patientId, appointmentId: req.body.appointmentId }));
});

const listDrafts = asyncHandler(async (req, res) => {
  res.json({ items: await aiService.listDrafts(req.ctx, { status: req.query.status, patientId: req.query.patientId, kind: req.query.kind }) });
});

const approve = asyncHandler(async (req, res) => {
  res.json(await aiService.approveDraft(req.ctx, req.params.id, { editedContent: req.body.editedContent, doctorId: req.body.doctorId }));
});

const reject = asyncHandler(async (req, res) => {
  res.json(await aiService.rejectDraft(req.ctx, req.params.id));
});

const search = asyncHandler(async (req, res) => {
  res.json(await aiService.semanticSearch(req.ctx, req.query.q));
});

module.exports = { faq, symptomIntake, visitSummary, listDrafts, approve, reject, search };
