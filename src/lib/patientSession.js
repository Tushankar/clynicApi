'use strict';

const crypto = require('crypto');
const config = require('../config/env');

/**
 * Signed patient-portal session tokens (issued after email OTP). HMAC-SHA256 over a
 * compact payload binding clinicId + patientId + email + expiry. Patients are NOT
 * Clerk users; this is their lightweight, tenant-scoped session.
 */
/**
 * Audiences. A token minted for the STORE (buy medicines) must not be accepted by the PORTAL
 * (read prescriptions, lab reports, invoices) — the two surfaces have different consent contexts
 * and different admission rules: the portal refuses to create a patient, while the store's OTP
 * path will match an existing chart. Without an audience claim the two tokens were byte-identical
 * and interchangeable. Legacy tokens carry no `aud` and are accepted by both until they expire.
 */
const AUDIENCE = Object.freeze({
  PORTAL: 'portal',
  STORE: 'store',
  // Short-lived, issued when a verified contact matches MORE THAN ONE patient (a shared household
  // phone/email). It proves the OTP was checked and carries the candidate ids, but grants no read
  // access on its own — it can only be exchanged for a real portal session by picking one of them.
  PORTAL_SELECT: 'portal-select',
});

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

/**
 * Verify AND enforce the audience. Each surface passes the audience it owns.
 * A token with no `aud` is a pre-existing session and is still accepted (none can be minted that
 * way any more); a token stamped for a DIFFERENT surface is rejected.
 */
function verifyFor(token, audience) {
  const data = verify(token);
  if (!data) return null;
  if (data.aud && data.aud !== audience) return null;
  return data;
}

module.exports = { sign, verify, verifyFor, AUDIENCE };
