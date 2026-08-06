'use strict';

const express = require('express');
const multer = require('multer');
const ctrl = require('../controllers/websiteController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');
const config = require('../config/env');

/**
 * Dashboard CMS (auth + plan-gated per §6.5 / 8.6), owner only.
 *   WEBSITE_LIVE (all plans): read config + publish toggle.
 *   CMS_BASIC   (standard+):  content + theme.
 *   CMS_ADVANCED(premium):    pages, reviews, seo.
 */
const router = express.Router();
router.use(requireRole('owner'));

router.get('/', requireFeature('WEBSITE_LIVE'), ctrl.getConfig);
router.post('/publish', requireFeature('WEBSITE_LIVE'), ctrl.publish);

router.put('/content', requireFeature('CMS_BASIC'), ctrl.putContent);
router.put('/theme', requireFeature('CMS_BASIC'), ctrl.putTheme);

// Media library — owners upload gallery/hero/logo images instead of hunting for a host.
// Bytes are stored PRIVATELY (hard rule 3); the site renders them via short-lived signed URLs.
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.storage.maxUploadBytes } });
router.post('/media/:slot', requireFeature('CMS_BASIC'), uploadImage.single('file'), ctrl.postMedia);
router.delete('/media/gallery/:index', requireFeature('CMS_BASIC'), ctrl.deleteGalleryImage);
router.put('/media/gallery/order', requireFeature('CMS_BASIC'), ctrl.putGalleryOrder);

router.get('/pages', requireFeature('CMS_ADVANCED'), ctrl.getPages);
router.post('/pages', requireFeature('CMS_ADVANCED'), ctrl.postPage);
router.put('/pages/:slug', requireFeature('CMS_ADVANCED'), ctrl.putPage);
router.delete('/pages/:slug', requireFeature('CMS_ADVANCED'), ctrl.deletePage);

router.get('/reviews', requireFeature('CMS_ADVANCED'), ctrl.getReviews);
router.put('/reviews', requireFeature('CMS_ADVANCED'), ctrl.putReviews);

router.put('/seo', requireFeature('CMS_ADVANCED'), ctrl.putSeo);

module.exports = router;
