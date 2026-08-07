'use strict';

const { Notification } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const realtime = require('../realtime/io');

/**
 * In-app notification center (§5.17). Events across the app call emit() to create
 * a notification + push it live over Socket.IO. High-frequency feed → not audited.
 * recipientId null = broadcast to all clinic staff.
 */
function repo(ctx) {
  return tenantRepo(Notification, ctx, { audit: false });
}

// Valid notification types, read from the schema so this can never drift out of sync.
const KNOWN_TYPES = new Set(Notification.schema.path('type').enumValues);

function recipientFilter(ctx) {
  return { $or: [{ recipientId: ctx.actorId }, { recipientId: null }] };
}

/**
 * Emit an in-app notification (+ live socket push). Robust by construction: an unknown `type`
 * is coerced to 'other' (and logged) rather than throwing enum validation — a silent-drop bug
 * previously meant new event types (review/waitlist) never reached the bell at all. emit never
 * throws into a caller's flow.
 */
async function emit(ctx, { type = 'other', message, link = null, recipientId = null, recipientType = 'staff', branchId = null, dedupeKey = null }) {
  if (!message) return null;
  let safeType = type;
  if (!KNOWN_TYPES.has(type)) {
    console.warn(`[notificationService] unknown notification type "${type}" — coerced to "other". Add it to the Notification.type enum.`);
    safeType = 'other';
  }
  try {
    // De-dup: if this alert carries a key and an UNREAD notification with the same key already
    // exists for the clinic, don't stack another one — return the existing (a new one reappears
    // only after staff clear the old). Guards recurring emitters (pharmacy sweep / stock writes).
    if (dedupeKey) {
      // "Still outstanding" differs by row type now that broadcasts track read state per user:
      // a targeted row is outstanding while read === false; a broadcast is outstanding until at
      // least one staff member has acknowledged it (readBy empty). Without the second branch a
      // broadcast's `read` would stay false forever and this check would suppress every future
      // alert for that key permanently.
      const existing = await repo(ctx).findOne({
        dedupeKey,
        $or: [
          { recipientId: { $ne: null }, read: false },
          { recipientId: null, read: false, readBy: { $size: 0 } },
        ],
      });
      if (existing) return existing;
    }
    const doc = await repo(ctx).create({ type: safeType, message, link, recipientId, recipientType, ...(dedupeKey ? { dedupeKey } : {}), ...(branchId ? { branchId } : {}) });
    realtime.emitNotification(ctx.clinicId, recipientId, {
      _id: String(doc._id),
      type: safeType,
      message,
      link,
      read: false,
      createdAt: doc.createdAt,
    });
    return doc;
  } catch (err) {
    console.error('[notificationService] failed to persist notification:', err?.message || err);
    return null;
  }
}

/**
 * Unread, from THIS user's point of view.
 *  - targeted row (recipientId === me): the shared `read` flag is mine alone, so it is authoritative
 *  - broadcast row (recipientId null): unread unless my id is in `readBy`. `read: true` on a
 *    broadcast is still honoured as a clinic-wide "cleared" signal (legacy rows, and system-driven
 *    clearing), so it counts as read for everyone.
 */
function unreadFilter(ctx) {
  return {
    $or: [
      { recipientId: ctx.actorId, read: false },
      { recipientId: null, read: false, readBy: { $ne: ctx.actorId } },
    ],
  };
}

/** Project the per-user read state onto a lean row so the client keeps a simple `read` boolean. */
function withMyReadState(ctx, rows) {
  return rows.map((n) => ({
    ...n,
    read: n.recipientId ? !!n.read : !!n.read || (n.readBy || []).includes(ctx.actorId),
  }));
}

async function list(ctx, { unreadOnly = false, limit = 30 } = {}) {
  const filter = unreadOnly ? unreadFilter(ctx) : recipientFilter(ctx);
  const rows = await repo(ctx).find(filter, { sort: { createdAt: -1 }, limit, lean: true });
  return withMyReadState(ctx, rows);
}

function unreadCount(ctx) {
  return repo(ctx).count(unreadFilter(ctx));
}

async function markRead(ctx, id) {
  const existing = await repo(ctx).findById(id);
  if (!existing) return null;
  // Clearing a shared row must only clear it for ME.
  if (!existing.recipientId) {
    await Notification.updateOne({ clinicId: ctx.clinicId, _id: id }, { $addToSet: { readBy: ctx.actorId } });
    return repo(ctx).findById(id);
  }
  return repo(ctx).updateById(id, { read: true });
}

async function markAllRead(ctx) {
  await Promise.all([
    // My own targeted notifications.
    Notification.updateMany({ clinicId: ctx.clinicId, recipientId: ctx.actorId, read: false }, { $set: { read: true } }),
    // Broadcasts: record that I have read them, leaving every colleague's bell untouched.
    Notification.updateMany({ clinicId: ctx.clinicId, recipientId: null, readBy: { $ne: ctx.actorId } }, { $addToSet: { readBy: ctx.actorId } }),
  ]);
  return { ok: true };
}

module.exports = { emit, list, unreadCount, markRead, markAllRead };
