'use strict';

/**
 * whatsappAdapter — Baileys (free/demo) or the official Cloud API (paid), added later
 * behind this same interface (10.5). Stub for Phase 1. WhatsApp reminders are a
 * Standard/Premium feature (plan map), never load-bearing on the free tier.
 */
async function send() {
  throw new Error('whatsapp channel not configured (Phase 1 uses email — see section 10.5)');
}

module.exports = { send };
