'use strict';

const express = require('express');
const multer = require('multer');
const ctrl = require('../controllers/reportController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');
const config = require('../config/env');

// Phase 2 — plan-gated (Standard/Premium). Files are private (hard rule 3).
const router = express.Router();
router.use(requireFeature('REPORT_UPLOADS'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.storage.maxUploadBytes } });
const ALL_STAFF = ['owner', 'doctor', 'receptionist'];

router.get('/', requireRole(...ALL_STAFF), ctrl.list);
router.post('/', requireRole(...ALL_STAFF), upload.single('file'), ctrl.upload);
router.get('/:id/signed-url', requireRole(...ALL_STAFF), ctrl.signedUrl);
router.delete('/:id', requireRole('owner', 'doctor'), ctrl.remove);

module.exports = router;
