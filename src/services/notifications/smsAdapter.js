'use strict';

/**
 * smsAdapter (MSG91 / Fast2SMS) — PAID, added after DLT registration (10.5).
 * Stub for Phase 1: interface-compatible so reminder logic never changes when it
 * lands. WhatsApp is gated to Standard/Premium per plan map (hard rule 5).
 */
async function send() {
  throw new Error('sms channel not configured (Phase 1 uses email; SMS arrives post-DLT — see section 10.5)');
}

module.exports = { send };
