'use strict';

const express = require('express');
const multer = require('multer');
const ctrl = require('../controllers/reportController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');
const config = require('../config/env');
const AppError = require('../utils/AppError');

// Phase 2 — plan-gated (Standard/Premium). Files are private (hard rule 3).
const router = express.Router();
router.use(requireFeature('REPORT_UPLOADS'));

// Medical reports are images, PDFs or DICOM. Without a fileFilter the client-supplied mimetype was
// stored verbatim and later echoed back as the response Content-Type by the signed byte route —
// so a staff member could upload an .html file declaring text/html and have it execute on the API
// origin when anyone opened the report. Mirrors ALLOWED_RX_MIME in storeOrderService.
const ALLOWED_REPORT_MIME = /^(image\/(jpeg|png|webp|heic|heif|tiff)|application\/pdf|application\/dicom)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.storage.maxUploadBytes },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_REPORT_MIME.test(file.mimetype || '')) {
      return cb(new AppError(400, 'Upload a report image (JPG/PNG/WebP/TIFF), a PDF, or a DICOM file'));
    }
    return cb(null, true);
  },
});
const ALL_STAFF = ['owner', 'doctor', 'receptionist'];

router.get('/', requireRole(...ALL_STAFF), ctrl.list);
router.post('/', requireRole(...ALL_STAFF), upload.single('file'), ctrl.upload);
router.get('/:id/signed-url', requireRole(...ALL_STAFF), ctrl.signedUrl);
router.delete('/:id', requireRole('owner', 'doctor'), ctrl.remove);

module.exports = router;
