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
    orgSlug: auth.orgSlug || null, // used to name/slug the clinic on first provision
    source: 'clerk',
  };
}

function prettify(slug) {
  return String(slug || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Just-in-time clinic provisioning. A clinic maps to a Clerk Organization (§3), but creating
 * the org in Clerk does not create the `clinics` row (that would normally arrive via a Clerk
 * webhook). So the first authenticated request for an org with no clinic row creates one here
 * (Basic plan) — the app is usable immediately, and the owner can edit details later. Idempotent
 * + race-safe (unique clinicId): concurrent first requests converge on one row.
 */
async function ensureClinic(clinicId, hints = {}) {
  const existing = await Clinic.findOne({ clinicId }).lean();
  if (existing) return existing;

  const name = prettify(hints.slug) || 'My Clinic';
  const base = (hints.slug || `clinic-${clinicId}`)
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'clinic';
  const create = async (slug) => (await Clinic.create({ clinicId, name, slug, subscriptionPlan: 'basic' })).toObject();
  try {
    return await create(base);
  } catch (err) {
    if (err.code === 11000) {
      // clinicId already taken (a concurrent request won) → use that row; otherwise the slug
      // collided with another clinic → retry with a unique suffix derived from the org id.
      const winner = await Clinic.findOne({ clinicId }).lean();
      if (winner) return winner;
      return create(`${base}-${String(clinicId).replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}`);
    }
    throw err;
  }
}

async function attachAuthContext(req, res, next) {
  try {
    const { clinicId, role, userId, orgSlug } = resolveIdentity(req);

    if (!userId) {
      throw new AppError(401, 'Not authenticated');
    }
    if (!clinicId) {
      // Authenticated but no active clinic/organization selected.
      throw new AppError(401, 'No active clinic. Select or create an organization.');
    }

    req.ctx = { clinicId, actorId: userId, actorRole: role };
    req.auth = { userId, clinicId, role };

    // Load (or provision on first use) the clinic doc so subscriptionPlan is available to
    // requireFeature (step 8). Direct lookup is legitimate here: the auth layer resolves the tenant.
    req.clinic = await ensureClinic(clinicId, { slug: orgSlug });

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

module.exports = { attachAuthContext, requireAuth, ensureClinic };
