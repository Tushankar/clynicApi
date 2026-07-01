'use strict';

const express = require('express');
const ctrl = require('../controllers/websiteController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');

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

router.get('/pages', requireFeature('CMS_ADVANCED'), ctrl.getPages);
router.post('/pages', requireFeature('CMS_ADVANCED'), ctrl.postPage);
router.put('/pages/:slug', requireFeature('CMS_ADVANCED'), ctrl.putPage);
router.delete('/pages/:slug', requireFeature('CMS_ADVANCED'), ctrl.deletePage);

router.get('/reviews', requireFeature('CMS_ADVANCED'), ctrl.getReviews);
router.put('/reviews', requireFeature('CMS_ADVANCED'), ctrl.putReviews);

router.put('/seo', requireFeature('CMS_ADVANCED'), ctrl.putSeo);

module.exports = router;
