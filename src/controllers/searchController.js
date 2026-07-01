'use strict';

const asyncHandler = require('../utils/asyncHandler');
const searchService = require('../services/searchService');

const search = asyncHandler(async (req, res) => {
  res.json(await searchService.search(req.ctx, req.query.q || ''));
});

module.exports = { search };
