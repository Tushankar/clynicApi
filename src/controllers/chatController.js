'use strict';

const { clerkClient } = require('@clerk/express');
const asyncHandler = require('../utils/asyncHandler');
const chatService = require('../services/chatService');
const config = require('../config/env');

/** Staff directory for choosing a chat recipient — real Clerk org members. */
const staff = asyncHandler(async (req, res) => {
  if (config.devAuth) return res.json({ items: [] }); // no Clerk directory in dev-auth mode
  try {
    const result = await clerkClient.organizations.getOrganizationMembershipList({ organizationId: req.ctx.clinicId, limit: 100 });
    const memberships = result.data || result;
    const items = memberships
      .map((m) => ({
        userId: m.publicUserData?.userId,
        name: [m.publicUserData?.firstName, m.publicUserData?.lastName].filter(Boolean).join(' ') || m.publicUserData?.identifier,
        role: m.role,
      }))
      .filter((u) => u.userId && u.userId !== req.ctx.actorId);
    res.json({ items });
  } catch {
    res.json({ items: [] });
  }
});

const conversation = asyncHandler(async (req, res) => {
  res.json({ items: await chatService.conversation(req.ctx, req.query.withStaffId) });
});
const send = asyncHandler(async (req, res) => {
  res.status(201).json(await chatService.send(req.ctx, { toStaffId: req.body.toStaffId, body: req.body.body, fromName: req.body.fromName }));
});
const markRead = asyncHandler(async (req, res) => res.json(await chatService.markRead(req.ctx, req.body.withStaffId)));
const unreadCount = asyncHandler(async (req, res) => res.json({ count: await chatService.unreadCount(req.ctx) }));

module.exports = { staff, conversation, send, markRead, unreadCount };
