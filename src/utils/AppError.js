'use strict';

/**
 * Operational error with an HTTP status code. Thrown by services/controllers
 * and translated to a JSON response by the central error handler.
 */
class AppError extends Error {
  constructor(statusCode, message, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.expose = true; // safe to show this message to the client
    Object.assign(this, extra);
    Error.captureStackTrace?.(this, AppError);
  }
}

module.exports = AppError;
