'use strict';

const express = require('express');
const ctrl = require('../controllers/websiteController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Website builder editing — Premium (rule 5), owner only (rule 4).
const router = express.Router();
router.use(requireRole('owner'), requireFeature('WEBSITE_BUILDER'));
router.get('/', ctrl.getContent);
router.put('/', ctrl.updateContent);

module.exports = router;
