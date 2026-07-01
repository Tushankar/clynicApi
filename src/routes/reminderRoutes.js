'use strict';

const express = require('express');
const ctrl = require('../controllers/reminderController');
const { requireRole } = require('../middleware/requireRole');

const router = express.Router();

router.get('/', requireRole('owner', 'receptionist'), ctrl.list);
router.post('/process', requireRole('owner'), ctrl.process); // ops/dev: flush due reminders now

module.exports = router;
