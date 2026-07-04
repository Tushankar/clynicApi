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
// Patient-facing AI (gated by the clinic's plan). Rule 2: logistics FAQ + symptom collection
// only — never diagnosis/advice (enforced in aiService/guard). Rate-limited like other writes.
router.post('/c/:slug/ai/faq', writeLimiter, ctrl.aiFaq);
router.post('/c/:slug/ai/symptom-intake', writeLimiter, ctrl.aiSymptomIntake);
// Voice receptionist turn (telephony provider webhook target). Rule 2 enforced in voiceService.
router.post('/c/:slug/voice', writeLimiter, ctrl.voiceTurn);

// ---- Waitlist + QR self check-in (§5.21 / 5.24) — plan-gated inside the services.
router.post('/c/:slug/waitlist', writeLimiter, ctrl.joinWaitlist);
router.get('/c/:slug/checkin', ctrl.checkinContext);
router.post('/c/:slug/checkin', writeLimiter, ctrl.selfCheckin);

// ---- Patient self-service via tokenized links (§5.20+). The HMAC token binds
// {type, clinic, record}; services re-check live state + plan on every call.
router.get('/manage/:token', ctrl.manageView);
router.get('/manage/:token/slots', ctrl.manageSlots);
router.post('/manage/:token/reschedule', writeLimiter, ctrl.manageReschedule);
router.post('/manage/:token/cancel', writeLimiter, ctrl.manageCancel);

router.get('/pay/:token', ctrl.payView);
router.post('/pay/:token/order', writeLimiter, ctrl.payOrder);
router.post('/pay/:token/verify', writeLimiter, ctrl.payVerify);
router.post('/pay/:token/mock-sign', writeLimiter, ctrl.payMockSign); // dev only

router.get('/review/:token', ctrl.reviewView);
router.post('/review/:token', writeLimiter, ctrl.reviewSubmit);

router.get('/doc/:token', ctrl.docView);

module.exports = router;
