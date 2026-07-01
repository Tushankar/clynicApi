'use strict';

const config = require('../../config/env');

/**
 * whatsappAdapter — official WhatsApp Business **Cloud API** (§10.5, step 8), behind the same
 * `send({ to, message })` interface as email/SMS so reminder logic never changes (10.5).
 *
 *   - driver 'mock' (default): logs and no-ops — used in dev/test and when WhatsApp isn't set up.
 *   - driver 'cloud': posts a text message via the Graph API (WABA phone number id + token).
 *
 * WhatsApp is a Standard/Premium feature (WHATSAPP_REMINDERS) and is NEVER load-bearing —
 * email remains the primary channel, so a WhatsApp failure degrades gracefully.
 */
function normalizeTo(to) {
  return String(to || '').replace(/[^\d]/g, ''); // Cloud API wants digits only (E.164 without +)
}

async function send({ to, message }) {
  const num = normalizeTo(to);
  if (!num) throw new Error('WhatsApp: missing recipient phone number');

  if (config.whatsapp.driver !== 'cloud') {
    // Dev/mock: don't actually message; make it observable without spamming.
    if (!config.isProd) console.log(`[whatsapp:mock] → ${num}: ${String(message).slice(0, 80)}`);
    return { channel: 'whatsapp', mock: true, to: num };
  }

  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.whatsapp.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: num, type: 'text', text: { body: message } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`WhatsApp Cloud API ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

module.exports = { send };
