'use strict';

const express = require('express');
const ctrl = require('../controllers/domainController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Custom domains — Premium (rule 5), owner only (rule 4).
const router = express.Router();
router.use(requireRole('owner'), requireFeature('CUSTOM_DOMAIN'));
router.get('/', ctrl.list);
router.post('/', ctrl.add);
router.post('/:id/verify', ctrl.verify);
router.delete('/:id', ctrl.remove);

module.exports = router;
