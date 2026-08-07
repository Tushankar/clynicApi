'use strict';

const asyncHandler = require('../utils/asyncHandler');
const adminService = require('../services/adminService');
const subscriptionService = require('../services/subscriptionService');

const analytics = asyncHandler(async (req, res) => {
  res.json(await adminService.platformAnalytics());
});

// Lets the frontend decide whether to show the Super-Admin area for the current user.
const me = asyncHandler(async (req, res) => {
  res.json({ isSuperAdmin: true });
});

const clinics = asyncHandler(async (req, res) => {
  res.json({ items: await adminService.listClinics({}) });
});

const setPlan = asyncHandler(async (req, res) => {
  res.json(await adminService.setClinicPlan(req.params.clinicId, req.body.plan));
});

// Body: { suspended: boolean, reason?: string }. req.ctx.actorId is threaded through so the audit
// trail names the operator instead of an anonymous 'system'.
const setSuspended = asyncHandler(async (req, res) => {
  res.json(
    await subscriptionService.setClinicSuspended(req.params.clinicId, !!req.body.suspended, {
      reason: req.body.reason,
      actorId: req.ctx?.actorId || null,
    })
  );
});

module.exports = { analytics, me, clinics, setPlan, setSuspended };
