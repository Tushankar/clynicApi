'use strict';

const reportService = require('../services/reportService');

/**
 * Streams report bytes for a valid signed token. NO Clerk auth — the HMAC token
 * IS the authorization (binds report, clinic, actor, expiry). Every successful
 * stream writes a "report viewed" audit (hard rules 3 + 7). There is no public URL.
 */
async function streamReport(req, res, next) {
  try {
    const { report, stream } = await reportService.streamReport(req.query.t, req.params.id);
    res.setHeader('Content-Type', report.mimeType || 'application/octet-stream');
    // Safe Content-Disposition: ASCII fallback + RFC5987 filename* (encodeURIComponent
    // percent-encodes any control chars, so no raw CR/LF can reach the header).
    const raw = report.originalName || 'report';
    const ascii = (raw.replace(/[^\w.\-]+/g, '_').slice(0, 120)) || 'report';
    const enc = encodeURIComponent(raw).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
    res.setHeader('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${enc}`);
    res.setHeader('Cache-Control', 'private, no-store'); // never cache medical files
    if (report.size) res.setHeader('Content-Length', report.size);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'stream_error' });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

module.exports = { streamReport };
