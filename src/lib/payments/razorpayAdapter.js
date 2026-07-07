'use strict';

const config = require('../../config/env');
const { hmacHex, safeEqualHex } = require('./verify');

/**
 * Real Razorpay adapter (production). Same verification math as the mock; only order
 * creation calls the live API. The `razorpay` SDK is lazy-required so dev/test boxes
 * without it (or without keys) never load it.
 */
let client = null;
function rzp() {
  if (client) return client;
  // eslint-disable-next-line global-require, import/no-unresolved
  const Razorpay = require('razorpay');
  client = new Razorpay({ key_id: config.payments.keyId, key_secret: config.payments.keySecret });
  return client;
}

async function createOrder({ amount, currency, receipt }) {
  const order = await rzp().orders.create({
    amount: Math.round(amount * 100), // Razorpay works in paise
    currency: currency || config.payments.currency,
    receipt,
  });
  return { id: order.id, amount, currency: order.currency, keyId: config.payments.keyId, receipt };
}

// Refund a captured payment back to the original method (partial or full). Razorpay works in paise.
async function refund({ paymentId, amount, notes }) {
  const r = await rzp().payments.refund(paymentId, { amount: Math.round(amount * 100), notes });
  return { id: r.id, paymentId, amount, status: r.status || 'processed' };
}

function verifyPaymentSignature({ orderId, paymentId, signature }) {
  return safeEqualHex(hmacHex(config.payments.keySecret, `${orderId}|${paymentId}`), signature);
}

function verifyWebhookSignature(rawBody, signature) {
  return safeEqualHex(hmacHex(config.payments.webhookSecret, rawBody), signature);
}

module.exports = { driver: 'razorpay', createOrder, refund, verifyPaymentSignature, verifyWebhookSignature };
