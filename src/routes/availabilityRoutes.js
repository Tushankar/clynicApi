'use strict';

const express = require('express');
const ctrl = require('../controllers/scheduleController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Doctor leave / clinic holidays / slot blocks (§5.20) — Standard+, front desk manages.
const router = express.Router();
router.use(requireFeature('AVAILABILITY_BLOCKS'));

const FRONT_DESK = ['owner', 'receptionist'];

router.get('/', requireRole(...FRONT_DESK, 'doctor'), ctrl.listBlocks);
router.post('/', requireRole(...FRONT_DESK), ctrl.createBlock);
router.post('/:id/cancel-impacted', requireRole(...FRONT_DESK), ctrl.cancelImpacted); // cancel & notify booked patients
router.delete('/:id', requireRole(...FRONT_DESK), ctrl.removeBlock);

module.exports = router;
