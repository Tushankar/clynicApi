'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { resolveFeatures, limitsForPlan } = require('../config/plans');

/**
 * /me — identity + plan introspection for the signed-in staff user.
 *
 * GET /me        -> who am I, which clinic, what role
 * GET /me/plan   -> the clinic's plan + resolved feature flags + limits
 *                   (the frontend uses this to hide/disable locked UI; the
 *                    backend middleware remains the real lock — hard rule 5)
 */
const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({
      userId: req.auth.userId,
      clinicId: req.auth.clinicId,
      role: req.auth.role,
      clinic: req.clinic
        ? { name: req.clinic.name, slug: req.clinic.slug, subscriptionPlan: req.clinic.subscriptionPlan }
        : null,
    });
  })
);

router.get(
  '/plan',
  asyncHandler(async (req, res) => {
    const plan = req.clinic?.subscriptionPlan || null;
    res.json({
      plan,
      features: plan ? resolveFeatures(plan) : {},
      limits: plan ? limitsForPlan(plan) : null,
    });
  })
);

module.exports = router;
