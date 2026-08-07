'use strict';

const express = require('express');
const ctrl = require('../controllers/dashboardController');
const { requireRole } = require('../middleware/requireRole');

// Dashboard home summary — clinic-scoped aggregate.
// No plan gate: it's the clinic's own home screen; individual widgets degrade gracefully.
// It DOES carry revenue and patient names, so it is restricted to the three clinical/front-desk
// roles (rule 4). Without this guard the pharmacy roles — and any Clerk org member whose role
// normalises to null — received the clinic's full financial and patient dashboard.
const router = express.Router();
router.get('/summary', requireRole('owner', 'doctor', 'receptionist'), ctrl.summary);

module.exports = router;
