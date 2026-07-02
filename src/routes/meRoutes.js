'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { resolveFeatures, limitsForPlan } = require('../config/plans');
const { requireRole } = require('../middleware/requireRole');
const { tenantRepo } = require('../lib/TenantRepository');
const { Clinic } = require('../models');
const AppError = require('../utils/AppError');

/**
 * /me — identity + clinic profile for the signed-in staff user.
 *
 * GET   /me         -> who am I, which clinic, role, + editable clinic profile fields
 * GET   /me/plan    -> the clinic's plan + resolved feature flags + limits (hard rule 5)
 * PATCH /me/clinic  -> owner updates the clinic profile (name/address/phone/gst). The address
 *                      etc. flow straight to the public website (§5.19). Audited via the tenant layer.
 */
const router = express.Router();

function clinicView(c) {
  if (!c) return null;
  return {
    name: c.name,
    slug: c.slug,
    address: c.address || '',
    phone: c.phone || '',
    gstNumber: c.gstNumber || '',
    logoUrl: c.logoUrl || '',
    subscriptionPlan: c.subscriptionPlan,
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({
      userId: req.auth.userId,
      clinicId: req.auth.clinicId,
      role: req.auth.role,
      clinic: clinicView(req.clinic),
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

router.patch(
  '/clinic',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const repo = tenantRepo(Clinic, req.ctx); // audited (rule 7), clinic-scoped (rule 1)
    const clinic = await repo.findOne({});
    if (!clinic) throw new AppError(404, 'Clinic not found');

    const patch = {};
    for (const key of ['name', 'address', 'phone', 'gstNumber']) {
      if (typeof req.body[key] === 'string') patch[key] = req.body[key].trim().slice(0, 300);
    }
    if (patch.name === '') delete patch.name; // name is required — never blank it
    const updated = await repo.updateById(clinic._id, patch);
    res.json({ clinic: clinicView(updated) });
  })
);

module.exports = router;
