'use strict';

const asyncHandler = require('../utils/asyncHandler');
const paymentService = require('../services/paymentService');
const gateway = require('../lib/payments');
const config = require('../config/env');
const AppError = require('../utils/AppError');

const createInvoiceOrder = asyncHandler(async (req, res) => {
  res.json(await paymentService.createInvoiceOrder(req.ctx, req.params.invoiceId));
});

// Server-side signature verification of a checkout callback (never trust the client).
const verify = asyncHandler(async (req, res) => {
  res.json(await paymentService.verifyPayment(req.ctx, { orderId: req.body.orderId, paymentId: req.body.paymentId, signature: req.body.signature }));
});

// Public webhook — signature verified over the raw body; idempotent.
const webhook = asyncHandler(async (req, res) => {
  const sig = req.headers['x-razorpay-signature'];
  const eventId = req.headers['x-razorpay-event-id'];
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  res.json(await paymentService.handleWebhook(raw, sig, eventId));
});

// Dev-only: simulate the gateway producing a valid signature so a mock checkout can complete.
const mockSign = asyncHandler(async (req, res) => {
  if (config.payments.driver !== 'mock') throw new AppError(404, 'Not found');
  const orderId = req.body.orderId;
  if (!orderId) throw new AppError(400, 'orderId is required');
  const paymentId = req.body.paymentId || `pay_mock_${Date.now()}${Math.floor(Math.random() * 1000)}`;
  res.json({ paymentId, signature: gateway.devSignPayment(orderId, paymentId) });
});

module.exports = { createInvoiceOrder, verify, webhook, mockSign };
