'use strict';

const asyncHandler = require('../utils/asyncHandler');
const messageLogService = require('../services/messageLogService');

const summary = asyncHandler(async (req, res) => {
  res.json(await messageLogService.summary(req.ctx));
});

const list = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({
    items: await messageLogService.list(req.ctx, {
      patientId: req.query.patientId,
      template: req.query.template,
      limit,
    }),
  });
});

module.exports = { summary, list };
