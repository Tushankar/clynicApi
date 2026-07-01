'use strict';

const asyncHandler = require('../utils/asyncHandler');
const reminderService = require('../services/reminderService');

const list = asyncHandler(async (req, res) => {
  const items = await reminderService.listReminders(req.ctx, {
    appointmentId: req.query.appointmentId,
    status: req.query.status,
  });
  res.json({ items });
});

/** Send any due reminders now (ops/dev — the worker/poller does this automatically). */
const process = asyncHandler(async (req, res) => {
  const result = await reminderService.processDueReminders({ clinicId: req.ctx.clinicId, now: new Date() });
  res.json(result);
});

module.exports = { list, process };
