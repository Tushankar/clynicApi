'use strict';

const asyncHandler = require('../utils/asyncHandler');
const invoiceService = require('../services/invoiceService');
const shareService = require('../services/shareService');

const list = asyncHandler(async (req, res) => {
  res.json({ items: await invoiceService.list(req.ctx, { patientId: req.query.patientId, appointmentId: req.query.appointmentId, status: req.query.status, date: req.query.date }) });
});
const get = asyncHandler(async (req, res) => res.json(await invoiceService.getById(req.ctx, req.params.id)));
const create = asyncHandler(async (req, res) => res.status(201).json(await invoiceService.create(req.ctx, req.body)));
const recordPayment = asyncHandler(async (req, res) => {
  res.json(await invoiceService.recordPayment(req.ctx, req.params.id, { amount: req.body.amount, method: req.body.method, reference: req.body.reference, idempotencyKey: req.body.idempotencyKey }));
});
const refund = asyncHandler(async (req, res) => res.json(await invoiceService.refund(req.ctx, req.params.id, { amount: req.body.amount, reason: req.body.reason })));
const remove = asyncHandler(async (req, res) => {
  const d = await invoiceService.softDelete(req.ctx, req.params.id);
  res.json({ ok: true, id: d._id, deletedAt: d.deletedAt });
});
const listDeleted = asyncHandler(async (req, res) => {
  res.json({ items: await invoiceService.listDeleted(req.ctx, {}) });
});
const restore = asyncHandler(async (req, res) => res.json(await invoiceService.restore(req.ctx, req.params.id)));

// Daily cash register (§5.23): method split + refunds + dues for a date.
const register = asyncHandler(async (req, res) => {
  res.json(await invoiceService.dayRegister(req.ctx, { date: req.query.date, branchId: req.query.branchId }));
});
// Send a pay-online link for this invoice's dues (email + WhatsApp when usable).
const sendPaymentLink = asyncHandler(async (req, res) => {
  res.json(await shareService.sendPaymentLink(req.ctx, req.params.id));
});
// Share the invoice as a tokenized view/download link.
const share = asyncHandler(async (req, res) => {
  res.json(await shareService.shareDocument(req.ctx, { kind: 'invoice', id: req.params.id }));
});

module.exports = { list, get, create, recordPayment, refund, remove, listDeleted, restore, register, sendPaymentLink, share };
