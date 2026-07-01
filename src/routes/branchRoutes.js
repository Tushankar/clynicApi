'use strict';

const express = require('express');
const ctrl = require('../controllers/branchController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

const router = express.Router();

// Listing branches is ungated: every clinic (any plan) needs its branch(es) resolved
// for branch-scoped queue/TV. Managing multiple branches is the Premium feature.
router.get('/', requireRole('owner', 'doctor', 'receptionist'), ctrl.list);

// Multi-branch management — Premium only (rule 5), owner only (rule 4).
router.post('/', requireRole('owner'), requireFeature('MULTI_BRANCH'), ctrl.create);
router.patch('/:id', requireRole('owner'), requireFeature('MULTI_BRANCH'), ctrl.update);
router.delete('/:id', requireRole('owner'), requireFeature('MULTI_BRANCH'), ctrl.remove);

module.exports = router;
