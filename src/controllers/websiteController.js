'use strict';

const asyncHandler = require('../utils/asyncHandler');
const websiteService = require('../services/websiteService');
const { slugFromRequest } = require('../lib/siteResolver');

// ---- Public (no auth) — resolved from Host header or ?slug= (path form) ----
const publicSite = asyncHandler(async (req, res) => {
  res.json(await websiteService.getPublicSite(slugFromRequest(req)));
});
const publicBookingData = asyncHandler(async (req, res) => {
  res.json(await websiteService.getBookingData(slugFromRequest(req)));
});

// ---- CMS (auth + plan-gated; clinic-scoped via req.ctx) ----
const getConfig = asyncHandler(async (req, res) => res.json(await websiteService.getSiteConfig(req.ctx)));
const putContent = asyncHandler(async (req, res) => res.json(await websiteService.updateContent(req.ctx, req.body.content || req.body)));
const putTheme = asyncHandler(async (req, res) => res.json(await websiteService.updateTheme(req.ctx, { template: req.body.template, theme: req.body.theme })));
const publish = asyncHandler(async (req, res) => res.json(await websiteService.setPublished(req.ctx, req.body.published)));

const getPages = asyncHandler(async (req, res) => res.json({ items: await websiteService.listPages(req.ctx) }));
const postPage = asyncHandler(async (req, res) => res.status(201).json(await websiteService.createPage(req.ctx, req.body)));
const putPage = asyncHandler(async (req, res) => res.json(await websiteService.updatePage(req.ctx, req.params.slug, req.body)));
const deletePage = asyncHandler(async (req, res) => res.json(await websiteService.deletePage(req.ctx, req.params.slug)));

const getReviews = asyncHandler(async (req, res) => res.json({ items: await websiteService.getReviews(req.ctx) }));
const putReviews = asyncHandler(async (req, res) => res.json(await websiteService.updateReviews(req.ctx, req.body.reviews || req.body)));
const putSeo = asyncHandler(async (req, res) => res.json(await websiteService.updateSeo(req.ctx, req.body.seo || req.body)));

module.exports = { publicSite, publicBookingData, getConfig, putContent, putTheme, publish, getPages, postPage, putPage, deletePage, getReviews, putReviews, putSeo };
