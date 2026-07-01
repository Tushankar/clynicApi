'use strict';

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/portalController');
const { patientAuth } = require('../middleware/patientAuth');
const config = require('../config/env');

/**
 * Patient portal API. Login is public (slug + email OTP, rate-limited); everything
 * else is behind patientAuth (a signed patient session token), which also enforces
 * the clinic's PATIENT_PORTAL plan gate and tenant isolation. NOT Clerk-protected.
 */
const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.storage.maxUploadBytes } });

// Public login
router.post('/c/:slug/login/request', loginLimiter, ctrl.requestLogin);
router.post('/c/:slug/login/verify', loginLimiter, ctrl.verifyLogin);

// Authenticated patient routes
router.use(patientAuth);
router.get('/me', ctrl.me);
router.get('/prescriptions', ctrl.prescriptions);
router.get('/invoices', ctrl.invoices);
router.get('/appointments', ctrl.appointments);
router.get('/reports', ctrl.reports);
router.get('/reports/:id/signed-url', ctrl.reportSignedUrl);
router.post('/reports', upload.single('file'), ctrl.uploadReport);
router.get('/queue', ctrl.queue);
router.post('/invoices/:id/pay-order', ctrl.payOrder);
router.post('/payments/verify', ctrl.payVerify);
router.post('/payments/mock-sign', ctrl.payMockSign); // dev only

module.exports = router;
