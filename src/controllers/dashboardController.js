'use strict';

const asyncHandler = require('../utils/asyncHandler');
const dashboardService = require('../services/dashboardService');

const summary = asyncHandler(async (req, res) => {
  res.json(await dashboardService.summary(req.ctx, { branchId: req.query.branchId }));
});

module.exports = { summary };
