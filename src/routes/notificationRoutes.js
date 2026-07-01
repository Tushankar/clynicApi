'use strict';

const express = require('express');
const ctrl = require('../controllers/notificationController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

const router = express.Router();
router.use(requireFeature('NOTIFICATION_CENTER'));
const ALL_STAFF = ['owner', 'doctor', 'receptionist'];

router.get('/', requireRole(...ALL_STAFF), ctrl.list);
router.get('/unread-count', requireRole(...ALL_STAFF), ctrl.unreadCount);
router.post('/:id/read', requireRole(...ALL_STAFF), ctrl.markRead);
router.post('/read-all', requireRole(...ALL_STAFF), ctrl.markAllRead);

module.exports = router;
