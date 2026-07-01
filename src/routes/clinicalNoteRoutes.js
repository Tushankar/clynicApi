'use strict';

const express = require('express');
const ctrl = require('../controllers/clinicalController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Notes ship with the prescriptions/consultation bundle (Standard/Premium).
const router = express.Router();
router.use(requireFeature('PRESCRIPTIONS'));

router.get('/', requireRole('owner', 'doctor', 'receptionist'), ctrl.listNotes);
router.post('/', requireRole('owner', 'doctor'), ctrl.createNote);
router.delete('/:id', requireRole('owner', 'doctor'), ctrl.removeNote);

module.exports = router;
