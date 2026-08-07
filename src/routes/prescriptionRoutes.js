'use strict';

const express = require('express');
const ctrl = require('../controllers/prescriptionController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');
const { PHARMACY_STAFF } = require('../config/roles');

// Phase 2 — plan-gated (Standard/Premium). Basic → 403 upgrade_required (Rule 5).
const router = express.Router();
router.use(requireFeature('PRESCRIPTIONS'));

const ALL_STAFF = ['owner', 'doctor', 'receptionist'];
// Pharmacy staff must be able to READ the prescription they are dispensing against. They still
// cannot create, share or delete one — those stay with the prescriber.
const LOOKUP_STAFF = [...ALL_STAFF, ...PHARMACY_STAFF];
router.get('/', requireRole(...LOOKUP_STAFF), ctrl.list);
router.get('/:id', requireRole(...LOOKUP_STAFF), ctrl.get);
router.post('/', requireRole('owner', 'doctor'), ctrl.create);
router.post('/:id/share', requireRole(...ALL_STAFF), requireFeature('DOCUMENT_SHARING'), ctrl.share);
router.delete('/:id', requireRole('owner', 'doctor'), ctrl.remove);

module.exports = router;
