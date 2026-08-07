'use strict';

const express = require('express');
const ctrl = require('../controllers/notificationController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');
const { PHARMACY_STAFF } = require('../config/roles');

const router = express.Router();
router.use(requireFeature('NOTIFICATION_CENTER'));
// Pharmacy staff are the ADDRESSEES of low_stock, stock_expiry and store_order notifications, so
// excluding them from the notification API meant those alerts could never be read by the only
// people who act on them.
const ALL_STAFF = ['owner', 'doctor', 'receptionist', ...PHARMACY_STAFF];

router.get('/', requireRole(...ALL_STAFF), ctrl.list);
router.get('/unread-count', requireRole(...ALL_STAFF), ctrl.unreadCount);
router.post('/:id/read', requireRole(...ALL_STAFF), ctrl.markRead);
router.post('/read-all', requireRole(...ALL_STAFF), ctrl.markAllRead);

module.exports = router;
