'use strict';

const express = require('express');
const ctrl = require('../controllers/exportController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// CSV export (§5.23) — Standard+, OWNER ONLY: full-book data leaves the system here.
const router = express.Router();
router.use(requireRole('owner'), requireFeature('DATA_EXPORT'));

router.get('/:entity', ctrl.exportCsv); // patients | appointments | invoices | expenses

module.exports = router;
