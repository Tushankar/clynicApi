'use strict';

const express = require('express');
const ctrl = require('../controllers/queueController');
const { requireRole } = require('../middleware/requireRole');

const router = express.Router();
const ALL_STAFF = ['owner', 'doctor', 'receptionist'];

router.get('/', requireRole(...ALL_STAFF), ctrl.get);
router.post('/call-next', requireRole(...ALL_STAFF), ctrl.callNext);
router.post('/:id/complete', requireRole(...ALL_STAFF), ctrl.complete);
router.post('/:id/skip', requireRole(...ALL_STAFF), ctrl.skip);

module.exports = router;
