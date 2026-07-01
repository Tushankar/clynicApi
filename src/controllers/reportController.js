'use strict';

const asyncHandler = require('../utils/asyncHandler');
const reportService = require('../services/reportService');

const list = asyncHandler(async (req, res) => {
  res.json({ items: await reportService.list(req.ctx, { patientId: req.query.patientId }) });
});

const upload = asyncHandler(async (req, res) => {
  const report = await reportService.upload(req.ctx, {
    patientId: req.body.patientId,
    type: req.body.type,
    title: req.body.title,
    file: req.file,
  });
  res.status(201).json(report);
});

// Returns a short-lived signed PATH (no public URL); the client prefixes the API base.
const signedUrl = asyncHandler(async (req, res) => {
  res.json(await reportService.getSignedUrl(req.ctx, req.params.id));
});

const remove = asyncHandler(async (req, res) => {
  const d = await reportService.softDelete(req.ctx, req.params.id);
  res.json({ ok: true, id: d._id, deletedAt: d.deletedAt });
});

module.exports = { list, upload, signedUrl, remove };
