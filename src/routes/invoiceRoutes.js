'use strict';

const express = require('express');
const ctrl = require('../controllers/invoiceController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Phase 3 — plan-gated (Standard/Premium). Basic → 403 upgrade_required.
const router = express.Router();
router.use(requireFeature('BILLING'));

const ALL_STAFF = ['owner', 'doctor', 'receptionist'];
const FRONT_DESK = ['owner', 'receptionist'];

router.get('/', requireRole(...ALL_STAFF), ctrl.list);
router.get('/:id', requireRole(...ALL_STAFF), ctrl.get);
router.post('/', requireRole(...FRONT_DESK), ctrl.create);
router.post('/:id/payments', requireRole(...FRONT_DESK), ctrl.recordPayment); // cash/UPI/card at the desk
router.post('/:id/refund', requireRole('owner'), ctrl.refund); // refunds are owner-only
router.delete('/:id', requireRole('owner'), ctrl.remove); // soft delete, owner-only

module.exports = router;
