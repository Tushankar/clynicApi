'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');
const { adapters } = require('../services/notifications');

/**
 * WhatsApp channel (Baileys) pairing — §10.5. The owner links the clinic's WhatsApp number
 * by scanning a QR from the CRM page; once paired, campaigns/reminders/re-engagement also
 * deliver on WhatsApp alongside email. Plan-gated (WHATSAPP_REMINDERS: Standard+).
 *
 * NOTE: the Baileys session is server-wide (one WhatsApp number per deployment) — the
 * QR/status endpoints are still auth + plan gated so only entitled staff can operate it.
 */
const router = express.Router();
router.use(requireRole('owner', 'receptionist'), requireFeature('WHATSAPP_REMINDERS'));

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const s = typeof adapters.whatsapp.getStatus === 'function' ? adapters.whatsapp.getStatus() : { enabled: false, status: 'disabled' };
    let qrDataUrl = null;
    if (s.qr) {
      const QRCode = require('qrcode'); // lazy — only while pairing
      qrDataUrl = await QRCode.toDataURL(s.qr, { margin: 1, width: 280 });
    }
    res.json({ enabled: s.enabled, status: s.status, connectedAs: s.me || null, qr: qrDataUrl, lastError: s.lastError || null });
  })
);

router.post(
  '/connect',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const s = await adapters.whatsapp.startPairing();
    res.json({ enabled: s.enabled, status: s.status, connectedAs: s.me || null });
  })
);

router.post(
  '/logout',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const s = await adapters.whatsapp.logout();
    res.json({ enabled: s.enabled, status: s.status });
  })
);

module.exports = router;
