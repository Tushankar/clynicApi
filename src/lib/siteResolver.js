'use strict';

const config = require('../config/env');

/**
 * Resolve the public-site slug from an incoming request (§8.6). Platform host only — there is
 * NO custom-domain branch. Two forms:
 *   1. Path/SPA form (local dev + primary):  ?slug=<slug>  (from PLATFORM_DOMAIN/c/<slug>)
 *   2. Subdomain form (prod):                Host: <slug>.PLATFORM_DOMAIN
 * Returns the slug string, or null if none. Reserved subdomains (www/app/api/admin) are ignored.
 */
const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'api', 'admin', 'dashboard']);

function slugFromRequest(req) {
  // 1) Explicit slug (the /c/<slug> path form the SPA passes as ?slug=).
  const q = String(req.query.slug || '').toLowerCase().trim();
  if (q) return sanitizeSlug(q);

  // 2) Subdomain of PLATFORM_DOMAIN.
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase().split(':')[0].trim();
  const base = config.platformDomain;
  if (host && base && host !== base && host.endsWith(`.${base}`)) {
    const sub = host.slice(0, host.length - base.length - 1);
    if (sub && !sub.includes('.') && !RESERVED_SUBDOMAINS.has(sub)) return sanitizeSlug(sub);
  }
  return null;
}

function sanitizeSlug(s) {
  const clean = String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return clean || null;
}

module.exports = { slugFromRequest, sanitizeSlug };
