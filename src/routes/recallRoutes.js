'use strict';

const express = require('express');
const ctrl = require('../controllers/scheduleController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Treatment recalls (§5.22) — Premium. Doctors can schedule; front desk manages.
const router = express.Router();
router.use(requireFeature('RECALLS'));

const ALL_STAFF = ['owner', 'doctor', 'receptionist'];
const FRONT_DESK = ['owner', 'receptionist'];

router.get('/', requireRole(...ALL_STAFF), ctrl.listRecalls);
router.post('/', requireRole(...ALL_STAFF), ctrl.createRecall);
router.post('/:id/cancel', requireRole(...FRONT_DESK), ctrl.cancelRecall);

module.exports = router;
