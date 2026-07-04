'use strict';

const asyncHandler = require('../utils/asyncHandler');
const expenseService = require('../services/expenseService');

const list = asyncHandler(async (req, res) => {
  res.json(await expenseService.list(req.ctx, { from: req.query.from, to: req.query.to, category: req.query.category, branchId: req.query.branchId }));
});
const create = asyncHandler(async (req, res) => {
  res.status(201).json(await expenseService.create(req.ctx, req.body));
});
const remove = asyncHandler(async (req, res) => {
  await expenseService.remove(req.ctx, req.params.id);
  res.json({ ok: true });
});
const categories = asyncHandler(async (req, res) => {
  res.json({ items: expenseService.CATEGORIES });
});

module.exports = { list, create, remove, categories };
