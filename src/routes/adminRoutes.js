'use strict';

const express = require('express');
const ctrl = require('../controllers/adminController');
const { requireSuperAdmin } = require('../middleware/requireSuperAdmin');

// Super-admin platform analytics — the one cross-clinic area. Allowlist-gated;
// clinic users get 403. Aggregates only, no patient data.
const router = express.Router();
router.use(requireSuperAdmin);
router.get('/me', ctrl.me);
router.get('/analytics', ctrl.analytics);

module.exports = router;
