'use strict';

const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Super-admin gate (the ONE sanctioned cross-clinic exception, §2). Allowlist of
 * Clerk user ids in SUPER_ADMIN_IDS. Runs after attachAuthContext. Clinic users
 * (not in the allowlist) get 403 — they can never reach platform analytics.
 */
function requireSuperAdmin(req, res, next) {
  const uid = req.auth?.userId;
  if (!uid || !config.superAdminIds.includes(uid)) {
    return next(new AppError(403, 'Super admin access only'));
  }
  next();
}

module.exports = { requireSuperAdmin };
