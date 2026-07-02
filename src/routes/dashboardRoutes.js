'use strict';

const express = require('express');
const ctrl = require('../controllers/dashboardController');

// Dashboard home summary — all staff (owner/doctor/receptionist). Clinic-scoped aggregate.
// No plan gate: it's the clinic's own home screen; individual widgets degrade gracefully.
const router = express.Router();
router.get('/summary', ctrl.summary);

module.exports = router;
