'use strict';

const crypto = require('crypto');

/** Shared HMAC helpers — identical math to Razorpay's signature scheme. */
function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqualHex(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = { hmacHex, safeEqualHex };
