'use strict';

const asyncHandler = require('../utils/asyncHandler');
const analyticsService = require('../services/analyticsService');

const overview = asyncHandler(async (req, res) => {
  res.json(await analyticsService.overview(req.ctx, { from: req.query.from, to: req.query.to, branchId: req.query.branchId }));
});

module.exports = { overview };
