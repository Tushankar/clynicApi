'use strict';

const express = require('express');
const ctrl = require('../controllers/chatController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

const router = express.Router();
router.use(requireFeature('INTERNAL_CHAT'));
const ALL_STAFF = ['owner', 'doctor', 'receptionist'];

router.get('/staff', requireRole(...ALL_STAFF), ctrl.staff);
router.get('/unread-count', requireRole(...ALL_STAFF), ctrl.unreadCount);
router.get('/', requireRole(...ALL_STAFF), ctrl.conversation);
router.post('/', requireRole(...ALL_STAFF), ctrl.send);
router.post('/read', requireRole(...ALL_STAFF), ctrl.markRead);

module.exports = router;
