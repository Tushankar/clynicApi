'use strict';

const asyncHandler = require('../utils/asyncHandler');
const crmService = require('../services/crmService');

const summary = asyncHandler(async (req, res) => {
  res.json(await crmService.summary(req.ctx));
});

const segment = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ items: await crmService.segment(req.ctx, req.params.key, { limit }) });
});

const reengage = asyncHandler(async (req, res) => {
  // Pass the clinic display name for the message body (ctx carries only ids/role).
  res.json(await crmService.reengage({ ...req.ctx, clinicName: req.clinic?.name }, req.params.id));
});

module.exports = { summary, segment, reengage };
