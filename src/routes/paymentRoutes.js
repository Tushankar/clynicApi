'use strict';

const express = require('express');
const ctrl = require('../controllers/paymentController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Authenticated payment endpoints (reception-initiated online collection). Gated BILLING.
const router = express.Router();
router.use(requireFeature('BILLING'));

router.post('/invoice/:invoiceId/order', requireRole('owner', 'receptionist'), ctrl.createInvoiceOrder);
router.post('/verify', requireRole('owner', 'doctor', 'receptionist'), ctrl.verify);
router.post('/mock-sign', requireRole('owner', 'doctor', 'receptionist'), ctrl.mockSign); // dev only

module.exports = router;
