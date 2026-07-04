'use strict';

const { AuditLog, Staff } = require('../models');

/**
 * Clinic activity feed (owner-only) — a readable view over the append-only audit log
 * (hard rule 7). Deliberately METADATA ONLY: who did what to which entity and when.
 * The audit rows' before/after snapshots can contain patient data, so they are NEVER
 * returned here — a settings activity log must not become a PHI side-channel.
 *
 * Clinic-scoped by an explicit clinicId match (this bypasses the tenant repo, so that
 * match IS the isolation guarantee — hard rule 1).
 */

const ACTOR_SYSTEM = new Set(['system', 'system:webhook', 'public', 'patient-link', 'self-checkin']);

/** Resolve Clerk actorIds → staff names for this clinic (best-effort; falls back to role). */
async function resolveActorNames(clinicId, actorIds) {
  const ids = [...new Set(actorIds.filter((id) => id && !ACTOR_SYSTEM.has(id)))];
  if (!ids.length) return new Map();
  const staff = await Staff.find({ clinicId, clerkUserId: { $in: ids } }, { clerkUserId: 1, name: 1 }).lean();
  return new Map(staff.map((s) => [s.clerkUserId, s.name]));
}

function actorLabel(entry, names) {
  if (!entry.actorId || ACTOR_SYSTEM.has(entry.actorId)) return { name: 'System', kind: 'system' };
  const name = names.get(entry.actorId);
  if (name) return { name, kind: 'staff' };
  // No staff profile on file — fall back to the role, else a short id.
  if (entry.actorRole) return { name: `${entry.actorRole[0].toUpperCase()}${entry.actorRole.slice(1)}`, kind: 'staff' };
  return { name: `User ${String(entry.actorId).slice(-6)}`, kind: 'staff' };
}

async function recentActivity(ctx, { limit = 60, entityType, action } = {}) {
  const filter = { clinicId: ctx.clinicId };
  if (entityType) filter.entityType = entityType;
  if (action) filter.action = action;

  const rows = await AuditLog.find(filter, { actorId: 1, actorRole: 1, action: 1, entityType: 1, entityId: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 60)))
    .lean();

  const names = await resolveActorNames(ctx.clinicId, rows.map((r) => r.actorId));

  return rows.map((r) => {
    const actor = actorLabel(r, names);
    return {
      id: String(r._id),
      action: r.action, // create | update | delete | read
      entityType: r.entityType, // Patient | Appointment | Invoice | …
      entityId: String(r.entityId),
      actorId: r.actorId || null, // lets the client badge "You"
      actorName: actor.name,
      actorKind: actor.kind, // staff | system
      actorRole: r.actorRole || null,
      at: r.createdAt,
    };
  });
}

module.exports = { recentActivity };
