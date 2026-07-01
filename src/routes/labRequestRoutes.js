'use strict';

const express = require('express');
const ctrl = require('../controllers/clinicalController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

const router = express.Router();
router.use(requireFeature('PRESCRIPTIONS'));

router.get('/', requireRole('owner', 'doctor', 'receptionist'), ctrl.listLabs);
router.post('/', requireRole('owner', 'doctor'), ctrl.createLab);
router.patch('/:id/status', requireRole('owner', 'doctor', 'receptionist'), ctrl.setLabStatus);
router.delete('/:id', requireRole('owner', 'doctor'), ctrl.removeLab);

module.exports = router;
