'use strict';

const asyncHandler = require('../utils/asyncHandler');
const exportService = require('../services/exportService');

const exportCsv = asyncHandler(async (req, res) => {
  const { filename, csv } = await exportService.exportCsv(req.ctx, req.params.entity, { from: req.query.from, to: req.query.to });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

module.exports = { exportCsv };
