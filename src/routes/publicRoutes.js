'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/publicController');

/**
 * Public booking API — NO Clerk auth. Every handler resolves clinicId from the
 * page slug and scopes strictly to it (hard rule 1). Mounted at /api/public.
 *
 * Sensitive write paths (OTP request/verify, booking) are IP-rate-limited as
 * defense-in-depth on top of the per-email throttling in otpService.
 */
const router = express.Router();

// 20 sensitive requests / 15 min / IP (memory store — fine for a single instance).
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many requests. Please try again later.' },
});

router.get('/c/:slug', ctrl.getClinic);
router.get('/c/:slug/slots', ctrl.slots);
router.get('/c/:slug/queue', ctrl.queue);
router.post('/c/:slug/otp/request', writeLimiter, ctrl.requestOtp);
router.post('/c/:slug/otp/verify', writeLimiter, ctrl.verifyOtp);
router.post('/c/:slug/book', writeLimiter, ctrl.book);
// Online prepayment (server-side verified). Amounts come from the server, never the client.
router.post('/c/:slug/appointments/:appointmentId/pay-order', writeLimiter, ctrl.prepayOrder);
router.post('/c/:slug/payments/verify', writeLimiter, ctrl.prepayVerify);
router.post('/c/:slug/payments/mock-sign', writeLimiter, ctrl.prepayMockSign); // dev only

module.exports = router;
