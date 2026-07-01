'use strict';

const crypto = require('crypto');
const config = require('../../config/env');
const { hmacHex, safeEqualHex } = require('./verify');

/**
 * Mock payment gateway for dev/test. Uses the SAME HMAC-SHA256 signature scheme as
 * Razorpay, so the server-side verification + webhook idempotency logic is exercised
 * for real — only the "gateway" is local. Production uses razorpayAdapter instead.
 */
async function createOrder({ amount, currency, receipt }) {
  return {
    id: `order_mock_${crypto.randomBytes(8).toString('hex')}`,
    amount,
    currency: currency || config.payments.currency,
    keyId: config.payments.keyId,
    receipt,
  };
}

// Razorpay: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret)
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  return safeEqualHex(hmacHex(config.payments.keySecret, `${orderId}|${paymentId}`), signature);
}

// Razorpay: signature = HMAC_SHA256(rawBody, webhook_secret)
function verifyWebhookSignature(rawBody, signature) {
  return safeEqualHex(hmacHex(config.payments.webhookSecret, rawBody), signature);
}

// Dev-only helpers that simulate the gateway producing valid signatures so the
// flow can be completed (and tested) without a real Razorpay checkout.
function devSignPayment(orderId, paymentId) {
  return hmacHex(config.payments.keySecret, `${orderId}|${paymentId}`);
}
function devSignWebhook(rawBody) {
  return hmacHex(config.payments.webhookSecret, rawBody);
}

module.exports = { driver: 'mock', createOrder, verifyPaymentSignature, verifyWebhookSignature, devSignPayment, devSignWebhook };
