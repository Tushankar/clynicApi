'use strict';

const express = require('express');
const ctrl = require('../controllers/aiController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

/**
 * AI assistant (§5.10) — Premium (rule 5). Hard rule 2 is enforced in the service/guard,
 * not here. Clinical generation + approval is doctor/owner; FAQ + search are any staff.
 */
const router = express.Router();
router.use(requireFeature('AI_FEATURES'));

router.post('/faq', requireRole('owner', 'doctor', 'receptionist'), ctrl.faq);
router.get('/search', requireRole('owner', 'doctor', 'receptionist'), ctrl.search);
router.post('/symptom-intake', requireRole('owner', 'doctor', 'receptionist'), ctrl.symptomIntake);

// Clinical AI generation + the doctor-approval workflow — doctor/owner only.
router.post('/visit-summary', requireRole('owner', 'doctor'), ctrl.visitSummary);
router.get('/drafts', requireRole('owner', 'doctor'), ctrl.listDrafts);
router.post('/drafts/:id/approve', requireRole('owner', 'doctor'), ctrl.approve);
router.post('/drafts/:id/reject', requireRole('owner', 'doctor'), ctrl.reject);

module.exports = router;
