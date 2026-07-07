'use strict';

const config = require('../../config/env');

/**
 * SMS channel adapter (§10.5). Config-driven via SMS_DRIVER:
 *   - 'none' (default): NOT configured — send() throws a clear, actionable error (the old stub threw
 *     a cryptic "Phase 1" message that surfaced to phone-only patients as a dead end at OTP login).
 *   - 'msg91' / 'fast2sms': send via the provider's documented HTTP API using global fetch.
 *
 * Interface-compatible with the other channel adapters (send({ to, message })). Indian transactional
 * SMS is DLT-gated: set SMS_SENDER_ID + SMS_DLT_TEMPLATE_ID (registered with your provider) for prod.
 * NOTE: the provider calls follow each vendor's public API but should be verified against a live
 * account + DLT template before go-live — SMS stays non-load-bearing (email/WhatsApp are primaries).
 */
function isConfigured() {
  return config.sms.driver !== 'none' && !!config.sms.apiKey;
}

function normalizeMobile(to) {
  const ten = String(to || '').replace(/\D/g, '').slice(-10);
  if (ten.length !== 10) throw new Error('SMS recipient must be a 10-digit Indian mobile number');
  return ten;
}

async function sendViaMsg91(ten, message) {
  // MSG91 Flow API — the DLT template referenced by SMS_DLT_TEMPLATE_ID maps `var1` into the body.
  const res = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey: config.sms.apiKey },
    body: JSON.stringify({
      template_id: config.sms.dltTemplateId,
      sender: config.sms.senderId,
      recipients: [{ mobiles: `91${ten}`, var1: message }],
    }),
  });
  if (!res.ok) throw new Error(`MSG91 SMS send failed (HTTP ${res.status})`);
}

async function sendViaFast2sms(ten, message) {
  // Fast2SMS bulkV2 API. 'dlt' route (production; needs sender_id + template_id) or 'q' (quick, dev).
  const route = config.sms.route || (config.sms.dltTemplateId ? 'dlt' : 'q');
  const params = new URLSearchParams({ route, message, numbers: ten, language: 'english' });
  if (route === 'dlt') {
    params.set('sender_id', config.sms.senderId);
    params.set('template_id', config.sms.dltTemplateId);
  }
  const res = await fetch(`https://www.fast2sms.com/dev/bulkV2?${params.toString()}`, {
    method: 'GET',
    headers: { authorization: config.sms.apiKey },
  });
  if (!res.ok) throw new Error(`Fast2SMS send failed (HTTP ${res.status})`);
}

async function send({ to, message } = {}) {
  if (!isConfigured()) {
    throw new Error('SMS is not configured (set SMS_DRIVER=msg91|fast2sms and SMS_API_KEY). Email/WhatsApp remain available.');
  }
  const ten = normalizeMobile(to);
  if (config.sms.driver === 'msg91') return sendViaMsg91(ten, message);
  if (config.sms.driver === 'fast2sms') return sendViaFast2sms(ten, message);
  throw new Error(`Unknown SMS_DRIVER: ${config.sms.driver}`);
}

module.exports = { send, isConfigured };
