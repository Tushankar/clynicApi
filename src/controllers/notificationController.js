'use strict';

const asyncHandler = require('../utils/asyncHandler');
const notificationService = require('../services/notificationService');

const list = asyncHandler(async (req, res) => {
  res.json({ items: await notificationService.list(req.ctx, { unreadOnly: req.query.unreadOnly === 'true' }) });
});
const unreadCount = asyncHandler(async (req, res) => res.json({ count: await notificationService.unreadCount(req.ctx) }));
const markRead = asyncHandler(async (req, res) => res.json(await notificationService.markRead(req.ctx, req.params.id)));
const markAllRead = asyncHandler(async (req, res) => res.json(await notificationService.markAllRead(req.ctx)));

module.exports = { list, unreadCount, markRead, markAllRead };
