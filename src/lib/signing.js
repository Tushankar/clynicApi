'use strict';

const crypto = require('crypto');
const config = require('../config/env');

/**
 * Compact signed tokens for short-lived file URLs (hard rule 3).
 * A token is base64url(JSON payload) + '.' + HMAC-SHA256(payload). The payload
 * carries the bound report id, clinic id, actor, and expiry, so the bytes route
 * can authorize the request without a Clerk session (works in <img>/<a>), while
 * nothing can be tampered or replayed past expiry.
 */
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', config.fileSigningSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.fileSigningSecret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data.exp || Date.now() > Number(data.exp)) return null; // expired
  return data;
}

module.exports = { sign, verify };
