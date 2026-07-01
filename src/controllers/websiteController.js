'use strict';

const asyncHandler = require('../utils/asyncHandler');
const websiteService = require('../services/websiteService');

const getContent = asyncHandler(async (req, res) => {
  res.json({ content: await websiteService.getContent(req.ctx) });
});

const updateContent = asyncHandler(async (req, res) => {
  res.json({ content: await websiteService.updateContent(req.ctx, req.body.content || req.body) });
});

// Public (no auth) — resolved by slug.
const publicSite = asyncHandler(async (req, res) => {
  res.json(await websiteService.getPublicSite(req.params.slug));
});

module.exports = { getContent, updateContent, publicSite };
