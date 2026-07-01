'use strict';

const config = require('../config/env');

/** 404 for unmatched routes. */
function notFound(req, res, next) {
  res.status(404).json({ error: 'not_found', message: `No route ${req.method} ${req.originalUrl}` });
}

/** Central error handler. Translates known errors to safe JSON responses. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.statusCode || 500;
  let message = err.expose ? err.message : 'Internal server error';
  const body = {};

  // Mongoose validation / cast / duplicate-key errors -> 400/409.
  if (err.name === 'ValidationError') {
    status = 400;
    message = 'Validation failed';
    body.details = Object.fromEntries(Object.entries(err.errors || {}).map(([k, v]) => [k, v.message]));
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid value for ${err.path}`;
  } else if (err.code === 11000) {
    status = 409;
    message = 'Duplicate key';
    body.keyValue = err.keyValue;
  } else if (err.name === 'MulterError') {
    // File upload errors → client errors, not 500s.
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : 'Invalid file upload';
  }

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
  }

  // Carry through structured extras set on AppError (e.g. requiredRoles).
  for (const k of ['feature', 'requiredRoles', 'yourRole', 'plan']) {
    if (err[k] !== undefined) body[k] = err[k];
  }

  res.status(status).json({
    error: err.error || (status >= 500 ? 'server_error' : 'request_error'),
    message,
    ...body,
    // Stack traces only in LOCAL development — never in production/staging/test,
    // so a mis-set NODE_ENV can't leak internal paths/versions to clients.
    // The full error is always available server-side via console.error above.
    ...(config.isDev ? { stack: err.stack } : {}),
  });
}

module.exports = { notFound, errorHandler };
