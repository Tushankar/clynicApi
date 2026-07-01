'use strict';

const express = require('express');
const ctrl = require('../controllers/appointmentController');
const { requireRole } = require('../middleware/requireRole');

const router = express.Router();
const ALL_STAFF = ['owner', 'doctor', 'receptionist'];
const FRONT_DESK = ['owner', 'receptionist'];

// Reads
router.get('/', requireRole(...ALL_STAFF), ctrl.list);
router.get('/slots', requireRole(...ALL_STAFF), ctrl.slots); // before /:id
router.get('/:id', requireRole(...ALL_STAFF), ctrl.get);

// Booking + scheduling (front desk)
router.post('/', requireRole(...FRONT_DESK), ctrl.book);
router.post('/walk-in', requireRole(...FRONT_DESK), ctrl.walkIn);
router.post('/:id/check-in', requireRole(...FRONT_DESK), ctrl.checkIn);
router.patch('/:id/reschedule', requireRole(...FRONT_DESK), ctrl.reschedule);
router.post('/:id/cancel', requireRole(...FRONT_DESK), ctrl.cancel);

// Status transitions during the visit — doctors participate (call/complete).
router.patch('/:id/status', requireRole(...ALL_STAFF), ctrl.setStatus);

// Soft delete the record (destructive) — owner only.
router.delete('/:id', requireRole('owner'), ctrl.remove);

module.exports = router;
