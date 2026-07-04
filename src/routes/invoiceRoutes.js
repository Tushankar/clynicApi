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
// Literal paths BEFORE '/:id' — express matches in order.
router.get('/register', requireRole(...FRONT_DESK), requireFeature('CASH_REGISTER'), ctrl.register);
router.get('/deleted', requireRole('owner'), ctrl.listDeleted); // owner "recently deleted"
router.get('/:id', requireRole(...ALL_STAFF), ctrl.get);
router.post('/:id/restore', requireRole('owner'), ctrl.restore); // undo a soft delete (owner-only)
router.post('/', requireRole(...FRONT_DESK), ctrl.create);
router.post('/:id/payments', requireRole(...FRONT_DESK), ctrl.recordPayment); // cash/UPI/card at the desk
router.post('/:id/refund', requireRole('owner'), ctrl.refund); // refunds are owner-only
router.post('/:id/send-link', requireRole(...FRONT_DESK), requireFeature('PAYMENT_LINKS'), ctrl.sendPaymentLink);
router.post('/:id/share', requireRole(...FRONT_DESK), requireFeature('DOCUMENT_SHARING'), ctrl.share);
router.delete('/:id', requireRole('owner'), ctrl.remove); // soft delete, owner-only

module.exports = router;
