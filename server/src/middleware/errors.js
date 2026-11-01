'use strict';

const logger = require('../logger');

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(code = 'unauthorized', message = 'Authentication required') {
    return new ApiError(401, code, message);
  }

  static forbidden(code, message, details) {
    return new ApiError(403, code, message, details);
  }

  static notFound(code, message) {
    return new ApiError(404, code, message);
  }

  static conflict(code, message, details) {
    return new ApiError(409, code, message, details);
  }

  static tooMany(code, message) {
    return new ApiError(429, code, message);
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'route_not_found', message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error(err.message, { code: err.code });
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err && err.name === 'ValidationError') {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request payload failed validation',
        details: Object.entries(err.errors).map(([field, e]) => ({ field, message: e.message })),
      },
    });
  }

  if (err && err.name === 'CastError') {
    return res.status(400).json({ error: { code: 'invalid_id', message: `Invalid identifier for ${err.path}` } });
  }

  if (err && err.code === 11000) {
    return res.status(409).json({
      error: { code: 'duplicate_key', message: 'That record already exists', details: err.keyValue },
    });
  }

  logger.error('unhandled error', { message: err && err.message, stack: err && err.stack });
  return res.status(500).json({ error: { code: 'internal_error', message: 'Unexpected server error' } });
}

module.exports = { ApiError, asyncHandler, errorHandler, notFoundHandler };
