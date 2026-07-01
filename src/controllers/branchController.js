'use strict';

const asyncHandler = require('../utils/asyncHandler');
const branchService = require('../services/branchService');

const list = asyncHandler(async (req, res) => {
  res.json({ items: await branchService.listBranches(req.ctx) });
});

const create = asyncHandler(async (req, res) => {
  const branch = await branchService.createBranch(req.ctx, req.clinic?.subscriptionPlan, req.body);
  res.status(201).json(branch);
});

const update = asyncHandler(async (req, res) => {
  res.json(await branchService.updateBranch(req.ctx, req.params.id, req.body));
});

const remove = asyncHandler(async (req, res) => {
  const deleted = await branchService.deleteBranch(req.ctx, req.params.id);
  res.json({ ok: true, id: deleted._id, deletedAt: deleted.deletedAt });
});

module.exports = { list, create, update, remove };
