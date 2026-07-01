'use strict';

const asyncHandler = require('../utils/asyncHandler');
const appointmentService = require('../services/appointmentService');

const list = asyncHandler(async (req, res) => {
  const items = await appointmentService.list(req.ctx, req.query);
  res.json({ items });
});

const slots = asyncHandler(async (req, res) => {
  res.json(await appointmentService.availableSlots(req.ctx, { doctorId: req.query.doctorId, date: req.query.date }));
});

const get = asyncHandler(async (req, res) => {
  res.json(await appointmentService.getById(req.ctx, req.params.id));
});

const book = asyncHandler(async (req, res) => {
  res.status(201).json(await appointmentService.book(req.ctx, req.body));
});

const walkIn = asyncHandler(async (req, res) => {
  res.status(201).json(await appointmentService.registerWalkIn(req.ctx, req.body));
});

const checkIn = asyncHandler(async (req, res) => {
  res.json(await appointmentService.checkIn(req.ctx, req.params.id));
});

const setStatus = asyncHandler(async (req, res) => {
  res.json(await appointmentService.transition(req.ctx, req.params.id, req.body.status, { reason: req.body.reason }));
});

const reschedule = asyncHandler(async (req, res) => {
  res.json(await appointmentService.reschedule(req.ctx, req.params.id, req.body.scheduledAt));
});

const cancel = asyncHandler(async (req, res) => {
  res.json(await appointmentService.cancel(req.ctx, req.params.id, req.body?.reason));
});

const remove = asyncHandler(async (req, res) => {
  const deleted = await appointmentService.softDelete(req.ctx, req.params.id);
  res.json({ ok: true, id: deleted._id, deletedAt: deleted.deletedAt, deletedBy: deleted.deletedBy });
});

module.exports = { list, slots, get, book, walkIn, checkIn, setStatus, reschedule, cancel, remove };
