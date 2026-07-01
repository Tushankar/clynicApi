'use strict';

const asyncHandler = require('../utils/asyncHandler');
const domainService = require('../services/domainService');

const list = asyncHandler(async (req, res) => {
  res.json({ items: await domainService.listDomains(req.ctx) });
});

const add = asyncHandler(async (req, res) => {
  res.status(201).json(await domainService.addDomain(req.ctx, req.body.domain));
});

const verify = asyncHandler(async (req, res) => {
  res.json({ domain: await domainService.verifyDomain(req.ctx, req.params.id) });
});

const remove = asyncHandler(async (req, res) => {
  res.json(await domainService.removeDomain(req.ctx, req.params.id));
});

// Public: resolve an incoming custom host → clinic slug (no auth). Host from ?host= or header.
const resolve = asyncHandler(async (req, res) => {
  const host = req.query.host || req.headers['x-forwarded-host'] || req.headers.host;
  const resolved = await domainService.resolveClinicByHost(host);
  if (!resolved) return res.status(404).json({ error: 'not_found' });
  res.json(resolved);
});

module.exports = { list, add, verify, remove, resolve };
