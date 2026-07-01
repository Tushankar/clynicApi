'use strict';

/**
 * Wrap an async Express handler so rejected promises reach the error middleware
 * instead of hanging the request.
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
