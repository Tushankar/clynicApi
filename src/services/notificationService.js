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

function recipientFilter(ctx) {
  return { $or: [{ recipientId: ctx.actorId }, { recipientId: null }] };
}

async function emit(ctx, { type = 'other', message, link = null, recipientId = null, recipientType = 'staff', branchId = null }) {
  if (!message) return null;
  const doc = await repo(ctx).create({ type, message, link, recipientId, recipientType, ...(branchId ? { branchId } : {}) });
  realtime.emitNotification(ctx.clinicId, recipientId, {
    _id: String(doc._id),
    type,
    message,
    link,
    read: false,
    createdAt: doc.createdAt,
  });
  return doc;
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
