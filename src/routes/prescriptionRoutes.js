'use strict';

const express = require('express');
const ctrl = require('../controllers/prescriptionController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Phase 2 — plan-gated (Standard/Premium). Basic → 403 upgrade_required (Rule 5).
const router = express.Router();
router.use(requireFeature('PRESCRIPTIONS'));

const ALL_STAFF = ['owner', 'doctor', 'receptionist'];
router.get('/', requireRole(...ALL_STAFF), ctrl.list);
router.get('/:id', requireRole(...ALL_STAFF), ctrl.get);
router.post('/', requireRole('owner', 'doctor'), ctrl.create);
router.delete('/:id', requireRole('owner', 'doctor'), ctrl.remove);

module.exports = router;
