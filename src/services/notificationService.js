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
async function emit(ctx, { type = 'other', message, link = null, recipientId = null, recipientType = 'staff', branchId = null }) {
  if (!message) return null;
  let safeType = type;
  if (!KNOWN_TYPES.has(type)) {
    console.warn(`[notificationService] unknown notification type "${type}" — coerced to "other". Add it to the Notification.type enum.`);
    safeType = 'other';
  }
  try {
    const doc = await repo(ctx).create({ type: safeType, message, link, recipientId, recipientType, ...(branchId ? { branchId } : {}) });
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

function list(ctx, { unreadOnly = false, limit = 30 } = {}) {
  const filter = recipientFilter(ctx);
  if (unreadOnly) filter.read = false;
  return repo(ctx).find(filter, { sort: { createdAt: -1 }, limit, lean: true });
}

function unreadCount(ctx) {
  return repo(ctx).count({ ...recipientFilter(ctx), read: false });
}

async function markRead(ctx, id) {
  return repo(ctx).updateById(id, { read: true });
}

async function markAllRead(ctx) {
  await Notification.updateMany({ clinicId: ctx.clinicId, ...recipientFilter(ctx), read: false }, { $set: { read: true } });
  return { ok: true };
}

module.exports = { emit, list, unreadCount, markRead, markAllRead };
