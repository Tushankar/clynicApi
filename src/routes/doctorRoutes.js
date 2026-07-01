'use strict';

const express = require('express');
const ctrl = require('../controllers/doctorController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

const router = express.Router();
const ALL_STAFF = ['owner', 'doctor', 'receptionist'];

router.get('/', requireRole(...ALL_STAFF), ctrl.list);
router.get('/me', requireRole(...ALL_STAFF), ctrl.me); // before /:id
// Doctor dashboard — Phase 2, plan-gated (Rule 5).
router.get('/dashboard', requireRole('owner', 'doctor'), requireFeature('DOCTOR_DASHBOARD'), ctrl.dashboard);
router.get('/:id', requireRole(...ALL_STAFF), ctrl.get);
router.post('/', requireRole('owner'), ctrl.create); // managing practitioners is owner-level
router.patch('/:id', requireRole('owner'), ctrl.update);

module.exports = router;
