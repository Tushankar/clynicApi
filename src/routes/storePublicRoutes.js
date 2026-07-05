'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/storeController');

/**
 * Public storefront browse + email-OTP (Ultra Premium, §6.6). Mounted at /api/public/c/:slug/store
 * (mergeParams → req.params.slug). No Clerk. The store is 404-hidden for non-Ultra clinics inside the
 * service (resolveStore → PHARMACY_STOREFRONT). Tenant isolation: the clinic is resolved ONLY from :slug.
 */
const router = express.Router({ mergeParams: true });

// Rate-limit write/auth endpoints (mirrors publicRoutes' writeLimiter).
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many attempts. Please try again shortly.' } });

// Browse (read-only)
router.get('/', ctrl.home);
router.get('/categories', ctrl.categories);
router.get('/category/:catSlug', ctrl.category);
router.get('/symptoms/:tag', ctrl.symptom);
router.get('/search', ctrl.search);
router.get('/medicine/:id', ctrl.product);

// Email-OTP auth (verify mints a patient session for checkout)
router.post('/otp/request', otpLimiter, ctrl.otpRequest);
router.post('/otp/verify', otpLimiter, ctrl.otpVerify);

module.exports = router;
