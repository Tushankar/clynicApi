'use strict';

const crypto = require('crypto');
const config = require('../config/env');

/**
 * Signed patient-portal session tokens (issued after email OTP). HMAC-SHA256 over a
 * compact payload binding clinicId + patientId + email + expiry. Patients are NOT
 * Clerk users; this is their lightweight, tenant-scoped session.
 */
function sign(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.patientSessionSecret).update(p).digest('base64url');
  return `${p}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [p, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.patientSessionSecret).update(p).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data.exp || Date.now() > Number(data.exp)) return null;
  return data;
}

module.exports = { sign, verify };
