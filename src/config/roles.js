'use strict';

/**
 * Staff roles (hard rule 4 — RBAC).
 *
 * Clinics map onto Clerk Organizations; staff roles map onto Clerk ORG ROLES.
 * Clerk emits org roles prefixed with `org:` (e.g. `org:doctor`). Configure
 * custom org roles `owner`, `doctor`, `receptionist` in the Clerk dashboard.
 *
 * Clerk's built-in defaults are `org:admin` / `org:member`; for clinics that
 * still use the defaults we map `admin -> owner`. Anything unrecognized
 * resolves to null and will fail every RBAC guard (deny by default).
 */

const ROLES = Object.freeze({
  OWNER: 'owner',
  DOCTOR: 'doctor',
  RECEPTIONIST: 'receptionist',
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));

function normalizeRole(rawRole) {
  if (!rawRole || typeof rawRole !== 'string') return null;
  // Strip Clerk's `org:` prefix if present.
  let role = rawRole.startsWith('org:') ? rawRole.slice(4) : rawRole;
  role = role.toLowerCase().trim();
  // Map Clerk default admin -> clinic owner.
  if (role === 'admin') role = ROLES.OWNER;
  if (role === 'member') return null; // generic member is not a clinic staff role
  return ALL_ROLES.includes(role) ? role : null;
}

module.exports = { ROLES, ALL_ROLES, normalizeRole };
