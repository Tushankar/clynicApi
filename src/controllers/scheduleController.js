'use strict';

const asyncHandler = require('../utils/asyncHandler');
const availabilityBlockService = require('../services/availabilityBlockService');
const waitlistService = require('../services/waitlistService');
const recallService = require('../services/recallService');

/** Availability blocks (§5.20) + waitlist (§5.21) + recalls (§5.22) — staff side. */

// ---- Availability blocks ----
const listBlocks = asyncHandler(async (req, res) => {
  res.json({ items: await availabilityBlockService.list(req.ctx, { doctorId: req.query.doctorId, includePast: req.query.includePast === 'true' }) });
});
const createBlock = asyncHandler(async (req, res) => {
  res.status(201).json(await availabilityBlockService.create(req.ctx, req.body));
});
const removeBlock = asyncHandler(async (req, res) => {
  await availabilityBlockService.remove(req.ctx, req.params.id);
  res.json({ ok: true });
});
const cancelImpacted = asyncHandler(async (req, res) => {
  res.json(await availabilityBlockService.cancelImpacted(req.ctx, req.params.id, req.body?.reason));
});

// ---- Waitlist ----
const listWaitlist = asyncHandler(async (req, res) => {
  res.json({ items: await waitlistService.list(req.ctx, { date: req.query.date, doctorId: req.query.doctorId, status: req.query.status }) });
});
const setWaitlistStatus = asyncHandler(async (req, res) => {
  res.json(await waitlistService.setStatus(req.ctx, req.params.id, req.body.status));
});

// ---- Recalls ----
const listRecalls = asyncHandler(async (req, res) => {
  res.json({ items: await recallService.list(req.ctx, { status: req.query.status, patientId: req.query.patientId }) });
});
const createRecall = asyncHandler(async (req, res) => {
  res.status(201).json(await recallService.create(req.ctx, req.body));
});
const cancelRecall = asyncHandler(async (req, res) => {
  res.json(await recallService.cancel(req.ctx, req.params.id));
});

module.exports = { listBlocks, createBlock, removeBlock, cancelImpacted, listWaitlist, setWaitlistStatus, listRecalls, createRecall, cancelRecall };
