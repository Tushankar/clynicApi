'use strict';

const express = require('express');
const ctrl = require('../controllers/subscriptionController');
const { requireRole } = require('../middleware/requireRole');

// Plan management — owner only. NOT feature-gated (a Basic clinic must be able to upgrade).
const router = express.Router();
router.get('/', requireRole('owner'), ctrl.get);
router.post('/change', requireRole('owner'), ctrl.change);

module.exports = router;
