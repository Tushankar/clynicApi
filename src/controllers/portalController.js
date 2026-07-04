'use strict';

const asyncHandler = require('../utils/asyncHandler');
const portalService = require('../services/portalService');

const requestLogin = asyncHandler(async (req, res) => res.json(await portalService.requestLogin(req.params.slug, req.body.contact || req.body.email)));
const verifyLogin = asyncHandler(async (req, res) => res.json(await portalService.verifyLogin(req.params.slug, req.body.contact || req.body.email, req.body.code)));

const me = asyncHandler(async (req, res) => res.json(await portalService.me(req)));
const prescriptions = asyncHandler(async (req, res) => res.json({ items: await portalService.prescriptions(req) }));
const invoices = asyncHandler(async (req, res) => res.json({ items: await portalService.invoices(req) }));
const appointments = asyncHandler(async (req, res) => res.json({ items: await portalService.appointments(req) }));
const reports = asyncHandler(async (req, res) => res.json({ items: await portalService.reports(req) }));
const reportSignedUrl = asyncHandler(async (req, res) => res.json(await portalService.reportSignedUrl(req, req.params.id)));
const uploadReport = asyncHandler(async (req, res) => res.status(201).json(await portalService.uploadReport(req, { type: req.body.type, title: req.body.title, file: req.file })));
const queue = asyncHandler(async (req, res) => res.json(await portalService.queue(req)));
const payOrder = asyncHandler(async (req, res) => res.json(await portalService.payInvoiceOrder(req, req.params.id)));
const payVerify = asyncHandler(async (req, res) => res.json(await portalService.payInvoiceVerify(req, { orderId: req.body.orderId, paymentId: req.body.paymentId, signature: req.body.signature })));
const payMockSign = asyncHandler(async (req, res) => res.json(await portalService.payMockSign(req, { orderId: req.body.orderId, paymentId: req.body.paymentId })));

module.exports = { requestLogin, verifyLogin, me, prescriptions, invoices, appointments, reports, reportSignedUrl, uploadReport, queue, payOrder, payVerify, payMockSign };
