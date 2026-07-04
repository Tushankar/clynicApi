'use strict';

const asyncHandler = require('../utils/asyncHandler');
const analyticsService = require('../services/analyticsService');

const overview = asyncHandler(async (req, res) => {
  res.json(
    await analyticsService.overview(req.ctx, {
      from: req.query.from,
      to: req.query.to,
      branchId: req.query.branchId,
      plan: req.clinic?.subscriptionPlan, // gates the P&L block (EXPENSES)
    })
  );
});

module.exports = { overview };
