'use strict';

const asyncHandler = require('../utils/asyncHandler');
const invoiceService = require('../services/invoiceService');

const list = asyncHandler(async (req, res) => {
  res.json({ items: await invoiceService.list(req.ctx, { patientId: req.query.patientId, appointmentId: req.query.appointmentId, status: req.query.status, date: req.query.date }) });
});
const get = asyncHandler(async (req, res) => res.json(await invoiceService.getById(req.ctx, req.params.id)));
const create = asyncHandler(async (req, res) => res.status(201).json(await invoiceService.create(req.ctx, req.body)));
const recordPayment = asyncHandler(async (req, res) => {
  res.json(await invoiceService.recordPayment(req.ctx, req.params.id, { amount: req.body.amount, method: req.body.method, reference: req.body.reference }));
});
const refund = asyncHandler(async (req, res) => res.json(await invoiceService.refund(req.ctx, req.params.id, { amount: req.body.amount, reason: req.body.reason })));
const remove = asyncHandler(async (req, res) => {
  const d = await invoiceService.softDelete(req.ctx, req.params.id);
  res.json({ ok: true, id: d._id, deletedAt: d.deletedAt });
});

module.exports = { list, get, create, recordPayment, refund, remove };
