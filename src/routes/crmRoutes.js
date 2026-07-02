'use strict';

const express = require('express');
const multer = require('multer');
const ctrl = require('../controllers/crmController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

// Hero-image uploads: in memory, images only, capped at 8 MB (re-encoded server-side).
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(/^image\//.test(file.mimetype) ? null : new Error('Only image files are allowed'), /^image\//.test(file.mimetype)),
});

/**
 * CRM & retention (§5.13) — Standard + Premium (rule 5). Owner + receptionist run the
 * day-to-day (segments, re-engagement). Automation settings are owner-only; template
 * EDITING and AI personalization are Premium-only (TEMPLATE_EDITING / AI_FEATURES).
 */
const router = express.Router();
router.use(requireRole('owner', 'receptionist'), requireFeature('CRM'));

router.get('/summary', ctrl.summary);
router.get('/segment/:key', ctrl.segment);
router.post('/patients/:id/reengage', ctrl.reengage);

// Automation control panel (owner).
router.get('/settings', ctrl.getSettings);
router.patch('/settings', requireRole('owner'), requireFeature('CRM_AUTOMATION'), ctrl.updateSettings);
router.post('/campaigns/run', requireRole('owner'), requireFeature('CRM_AUTOMATION'), ctrl.runCampaign);

// Email design: color theme + templates. EDITING is Premium (TEMPLATE_EDITING); previewing is open to all CRM plans.
router.patch('/theme', requireRole('owner'), requireFeature('TEMPLATE_EDITING'), ctrl.updateTheme);
router.get('/templates/:kind/preview', ctrl.previewTemplate);
router.patch('/templates/:kind', requireRole('owner'), requireFeature('TEMPLATE_EDITING'), ctrl.updateTemplate);
router.post('/templates/:kind/image', requireRole('owner'), requireFeature('TEMPLATE_EDITING'), uploadImage.single('image'), ctrl.uploadImage);
router.post('/templates/:kind/test', requireRole('owner'), ctrl.testTemplate);

module.exports = router;
