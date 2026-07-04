'use strict';

const express = require('express');
const ctrl = require('../controllers/scheduleController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Cancellation waitlist (§5.21) — Standard+, front desk manages.
const router = express.Router();
router.use(requireFeature('WAITLIST'));

const FRONT_DESK = ['owner', 'receptionist'];

router.get('/', requireRole(...FRONT_DESK), ctrl.listWaitlist);
router.patch('/:id/status', requireRole(...FRONT_DESK), ctrl.setWaitlistStatus);

module.exports = router;
