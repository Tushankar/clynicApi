'use strict';

const express = require('express');
const ctrl = require('../controllers/searchController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

const router = express.Router();
router.use(requireFeature('UNIVERSAL_SEARCH'));
router.get('/', requireRole('owner', 'doctor', 'receptionist'), ctrl.search);

module.exports = router;
