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
// Team directory for linking a doctor to a login account (owner-only). Before /:id.
router.get('/staff-directory', requireRole('owner'), ctrl.staffDirectory);
router.get('/:id', requireRole(...ALL_STAFF), ctrl.get);
router.post('/', requireRole('owner'), ctrl.create); // adding a practitioner is owner-level
// Front desk can edit a doctor's profile + weekly working hours; FEES stay owner-only
// (enforced in the service — money-sensitive, like refunds/plan changes).
router.patch('/:id', requireRole('owner', 'receptionist'), ctrl.update);

module.exports = router;
