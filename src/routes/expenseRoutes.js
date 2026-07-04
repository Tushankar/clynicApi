'use strict';

const express = require('express');
const ctrl = require('../controllers/expenseController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Expense tracking (§5.23) — Premium. Front desk logs; only the owner deletes.
const router = express.Router();
router.use(requireFeature('EXPENSES'));

const FRONT_DESK = ['owner', 'receptionist'];

router.get('/categories', requireRole(...FRONT_DESK), ctrl.categories);
router.get('/', requireRole(...FRONT_DESK), ctrl.list);
router.post('/', requireRole(...FRONT_DESK), ctrl.create);
router.delete('/:id', requireRole('owner'), ctrl.remove);

module.exports = router;
