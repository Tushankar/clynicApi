'use strict';

const { getAuth } = require('@clerk/express');
const config = require('../config/env');
const { normalizeRole } = require('../config/roles');
const Clinic = require('../models/Clinic');
const AppError = require('../utils/AppError');

/**
 * Auth context middleware (hard rule 1 + 4).
 *
 * Resolves identity for every protected request and attaches:
 *   req.ctx    = { clinicId, actorId, actorRole }   <- consumed by TenantRepository
 *   req.auth   = { userId, clinicId, role }          <- convenience mirror
 *   req.clinic = the clinics document (or null)      <- carries subscriptionPlan (step 8)
 *
 * Identity source:
 *   - Normal: the Clerk session. clinicId = active Organization id, role = org role.
 *   - Dev only (DEV_AUTH=true, non-prod): identity from x-dev-* headers, so the API
 *     can be exercised locally without Clerk keys. The app refuses to boot if this
 *     is enabled in production (see config/env.js).
 */

function resolveIdentity(req) {
  if (config.devAuth) {
    const clinicId = req.header('x-dev-clinic-id');
    const role = normalizeRole(req.header('x-dev-role'));
    const userId = req.header('x-dev-user-id') || 'dev_user';
    return { clinicId, role, userId, source: 'dev-headers' };
  }

  // Clerk session (populated by clerkMiddleware() at the app level).
  const auth = getAuth(req);
  return {
    clinicId: auth.orgId || null, // active organization === clinic
    role: normalizeRole(auth.orgRole),
    userId: auth.userId || null,
    source: 'clerk',
  };
}

async function attachAuthContext(req, res, next) {
  try {
    const { clinicId, role, userId } = resolveIdentity(req);

    if (!userId) {
      throw new AppError(401, 'Not authenticated');
    }
    if (!clinicId) {
      // Authenticated but no active clinic/organization selected.
      throw new AppError(401, 'No active clinic. Select or create an organization.');
    }

    req.ctx = { clinicId, actorId: userId, actorRole: role };
    req.auth = { userId, clinicId, role };

    // Load the clinic doc so subscriptionPlan is available to requireFeature (step 8).
    // Direct lookup is legitimate here: the auth layer resolves the tenant itself.
    req.clinic = await Clinic.findOne({ clinicId }).lean();

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * requireAuth — gate that demands a resolved auth context.
 * (attachAuthContext already throws on missing identity; this is an explicit
 * route-level marker and a safety net if mounted standalone.)
 */
function requireAuth(req, res, next) {
  if (!req.ctx || !req.ctx.clinicId || !req.auth?.userId) {
    return next(new AppError(401, 'Not authenticated'));
  }
  next();
}

module.exports = { attachAuthContext, requireAuth };
