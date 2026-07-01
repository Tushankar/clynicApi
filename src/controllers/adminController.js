'use strict';

const asyncHandler = require('../utils/asyncHandler');
const adminService = require('../services/adminService');

const analytics = asyncHandler(async (req, res) => {
  res.json(await adminService.platformAnalytics());
});

// Lets the frontend decide whether to show the Super-Admin area for the current user.
const me = asyncHandler(async (req, res) => {
  res.json({ isSuperAdmin: true });
});

module.exports = { analytics, me };
