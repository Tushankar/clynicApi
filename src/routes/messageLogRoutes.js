'use strict';

const express = require('express');
const ctrl = require('../controllers/messageLogController');
const { requireRole } = require('../middleware/requireRole');

/**
 * Communications log — the owner/receptionist's view of every outbound message the clinic
 * sent (re-engagement, reminders): how many, to whom, which template. Read-only + clinic-scoped.
 */
const router = express.Router();
router.use(requireRole('owner', 'receptionist'));

router.get('/summary', ctrl.summary);
router.get('/', ctrl.list);

module.exports = router;
