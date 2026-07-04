'use strict';

const { sign, verify } = require('./signing');
const config = require('../config/env');

/**
 * Patient-facing tokenized links (§5.20+). One place mints and verifies every
 * public deep link — appointment manage (reschedule/cancel), invoice payment,
 * post-visit review, and shared documents. Tokens are HMAC-signed (lib/signing):
 * the payload binds the TYPE, the clinic, and the target id, so a token can never
 * be replayed against another flow, clinic, or record. Real validity (status,
 * amounts, plan entitlement) is always re-checked server-side at use time.
 */

const DAY_MS = 24 * 3600 * 1000;

const TTL_DAYS = {
  manage: 60, // outlives any realistic reschedule horizon
  pay: 30,
  review: 21,
  // Shared clinical docs are PHI (diagnosis + drug list). A forwarded link shouldn't stay live for
  // months — keep it short. Patients who want a lasting copy sign in to the portal (an auth session),
  // and every open is now audited (see selfServiceService.docView). Soft-deleting the record revokes it.
  doc: 7,
};

function mintToken(type, clinicId, id, extra = {}) {
  return sign({ t: type, cid: clinicId, id: String(id), exp: Date.now() + (TTL_DAYS[type] || 30) * DAY_MS, ...extra });
}

/** Verify a token and require the expected type. Returns the payload or null. */
function verifyToken(token, expectedType) {
  const data = verify(token);
  if (!data || data.t !== expectedType || !data.cid || !data.id) return null;
  return data;
}

const base = () => String(config.publicSiteBaseUrl || '').replace(/\/+$/, '');

const manageUrl = (clinicId, appointmentId) => `${base()}/manage/${mintToken('manage', clinicId, appointmentId)}`;
const payUrl = (clinicId, invoiceId) => `${base()}/pay/${mintToken('pay', clinicId, invoiceId)}`;
const reviewUrl = (clinicId, appointmentId) => `${base()}/review/${mintToken('review', clinicId, appointmentId)}`;
/** kind: 'invoice' | 'prescription' */
const docUrl = (clinicId, kind, id) => `${base()}/d/${mintToken('doc', clinicId, id, { k: kind })}`;
const bookingUrl = (slug) => `${base()}/c/${slug}/book`;
const checkinUrl = (slug) => `${base()}/c/${slug}/checkin`;

module.exports = { mintToken, verifyToken, manageUrl, payUrl, reviewUrl, docUrl, bookingUrl, checkinUrl };
