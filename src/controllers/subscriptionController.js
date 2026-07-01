'use strict';

const asyncHandler = require('../utils/asyncHandler');
const subscriptionService = require('../services/subscriptionService');
const { resolveFeatures } = require('../config/plans');

const get = asyncHandler(async (req, res) => {
  const sub = await subscriptionService.getSubscription(req.ctx);
  const plan = req.clinic?.subscriptionPlan || 'basic';
  res.json({ plan, subscription: sub, features: resolveFeatures(plan) });
});

const change = asyncHandler(async (req, res) => {
  res.json(await subscriptionService.requestPlanChange(req.ctx, req.body.plan));
});

module.exports = { get, change };
