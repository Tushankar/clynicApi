'use strict';

const express = require('express');
const ctrl = require('../controllers/analyticsController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Owner analytics — Premium (rule 5), owner only (rule 4). Clinic-scoped aggregates.
const router = express.Router();
router.use(requireRole('owner'), requireFeature('ANALYTICS'));
router.get('/overview', ctrl.overview);

module.exports = router;
