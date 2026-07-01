'use strict';

const { ChatMessage } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const realtime = require('../realtime/io');
const branchService = require('./branchService');
const AppError = require('../utils/AppError');

/** Internal reception↔doctor chat (§5.16). Tenant-isolated; high-frequency, not audited. */
function repo(ctx) {
  return tenantRepo(ChatMessage, ctx, { audit: false });
}

async function send(ctx, { toStaffId, body, fromName }) {
  if (!toStaffId) throw new AppError(400, 'Recipient is required');
  if (!body || !body.trim()) throw new AppError(400, 'Message body is required');
  const branch = await branchService.getOrCreatePrimaryBranch(ctx);
  const msg = await repo(ctx).create({ fromStaffId: ctx.actorId, fromName, toStaffId, body: body.trim(), branchId: branch._id });
  realtime.emitChatMessage(ctx.clinicId, toStaffId, {
    _id: String(msg._id),
    fromStaffId: ctx.actorId,
    fromName,
    toStaffId,
    body: msg.body,
    createdAt: msg.createdAt,
  });
  return msg;
}

function conversation(ctx, withStaffId, { limit = 200 } = {}) {
  return repo(ctx).find(
    { $or: [{ fromStaffId: ctx.actorId, toStaffId: withStaffId }, { fromStaffId: withStaffId, toStaffId: ctx.actorId }] },
    { sort: { createdAt: 1 }, limit, lean: true }
  );
}

async function markRead(ctx, withStaffId) {
  await ChatMessage.updateMany(
    { clinicId: ctx.clinicId, fromStaffId: withStaffId, toStaffId: ctx.actorId, read: false },
    { $set: { read: true } }
  );
  return { ok: true };
}

function unreadCount(ctx) {
  return repo(ctx).count({ toStaffId: ctx.actorId, read: false });
}

module.exports = { send, conversation, markRead, unreadCount };
