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
 *
 * Pharmacy roles (Ultra Premium module): `pharmacy_owner` and `pharmacy_manager` are
 * additive staff roles configured as custom Clerk org roles ONLY for clinics that run the
 * pharmacy add-on. Lower-tier clinics never configure `org:pharmacy_*`, so normalizeRole
 * never yields them there; and even where present, tier isolation is enforced by the
 * requireFeature('PHARMACY_*') gate, never by the role alone.
 */

const ROLES = Object.freeze({
  OWNER: 'owner',
  DOCTOR: 'doctor',
  RECEPTIONIST: 'receptionist',
  PHARMACY_OWNER: 'pharmacy_owner',
  PHARMACY_MANAGER: 'pharmacy_manager',
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));

/**
 * The clinical/front-desk roles. Most non-pharmacy routes are scoped to these three.
 */
const CLINIC_STAFF = Object.freeze([ROLES.OWNER, ROLES.DOCTOR, ROLES.RECEPTIONIST]);

/**
 * The pharmacy add-on roles.
 *
 * These were configured as Clerk org roles and given their own `/api/pharmacy` routes and sidebar
 * group, but were never added to the allowlists of the SHARED services the pharmacy module depends
 * on — so a pharmacist could open Dispense and then get 403 on the patient and prescription
 * lookups that are its mandatory first step. Exported so those grants are explicit and greppable
 * rather than a hand-copied literal in each route file.
 *
 * Scope is deliberately narrow: pharmacy staff get the READ lookups dispensing requires, and their
 * own notifications. They are intentionally NOT granted patient detail/timeline, clinical notes,
 * or any write to the clinical record.
 */
const PHARMACY_STAFF = Object.freeze([ROLES.PHARMACY_OWNER, ROLES.PHARMACY_MANAGER]);

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

module.exports = { ROLES, ALL_ROLES, CLINIC_STAFF, PHARMACY_STAFF, normalizeRole };
