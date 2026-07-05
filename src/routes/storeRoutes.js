'use strict';

const express = require('express');
const multer = require('multer');
const ctrl = require('../controllers/storeController');
const { storePatientAuth } = require('../middleware/storePatientAuth');
const config = require('../config/env');

/**
 * Authenticated storefront order flow (Ultra Premium, §6.6). Mounted at /api/store (no Clerk).
 * Every route is behind storePatientAuth, which verifies the patient session AND enforces the Ultra
 * PHARMACY_STOREFRONT gate — so non-Ultra clinics 404 and the live PATIENT_PORTAL is untouched.
 * clinicId + patientId come from the session (req.ctx / req.patient), never the client (tenant isolation).
 */
const router = express.Router();
router.use(storePatientAuth);

const uploadRx = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.storage.maxUploadBytes } });

router.get('/me', ctrl.me);
router.get('/orders', ctrl.listOrders);
router.post('/orders', ctrl.createOrder);
router.get('/orders/:id', ctrl.getOrder);
router.post('/orders/:id/prescription', uploadRx.single('file'), ctrl.uploadPrescription);
router.post('/orders/:id/pay-order', ctrl.payOrder);
router.post('/orders/:id/verify-payment', ctrl.verifyPayment);
router.post('/orders/:id/mock-sign', ctrl.mockSign); // dev-only; 404 unless payments driver is 'mock'

module.exports = router;
