'use strict';

const express = require('express');
const ctrl = require('../controllers/crmController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// CRM & retention — Premium (rule 5). Owner + receptionist (they run re-engagement).
const router = express.Router();
router.use(requireRole('owner', 'receptionist'), requireFeature('CRM'));

router.get('/summary', ctrl.summary);
router.get('/segment/:key', ctrl.segment);
router.post('/patients/:id/reengage', ctrl.reengage);

module.exports = router;
