'use strict';

const asyncHandler = require('../utils/asyncHandler');
const queueService = require('../services/queueService');
const branchService = require('../services/branchService');

async function resolveBranchId(req) {
  const fromReq = req.query.branchId || req.body?.branchId;
  if (fromReq) return fromReq;
  const branch = await branchService.getOrCreatePrimaryBranch(req.ctx);
  return branch._id;
}

const get = asyncHandler(async (req, res) => {
  const branchId = await resolveBranchId(req);
  // Authenticated reception view → full names.
  res.json(await queueService.snapshot(req.ctx, branchId, { display: false }));
});

const callNext = asyncHandler(async (req, res) => {
  const branchId = await resolveBranchId(req);
  res.json(await queueService.callNext(req.ctx, { branchId, doctorId: req.body?.doctorId }));
});

const complete = asyncHandler(async (req, res) => {
  res.json(await queueService.complete(req.ctx, req.params.id));
});

const skip = asyncHandler(async (req, res) => {
  res.json(await queueService.skip(req.ctx, req.params.id));
});

module.exports = { get, callNext, complete, skip };
