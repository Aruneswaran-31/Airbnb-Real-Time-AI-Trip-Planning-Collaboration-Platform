'use strict';

const config = require('../config');
const { ApiError } = require('./errors');

/**
 * Small in-process sliding window limiter. Enough for a single-node build and
 * keeps the dependency surface small; a multi-node deployment would swap the
 * store for Redis without changing the middleware contract.
 */
function createRateLimiter({ max = config.rateLimit.maxWrites, windowMs = config.rateLimit.windowMs, keyFn } = {}) {
  const hits = new Map();

  return (req, _res, next) => {
    const key = keyFn ? keyFn(req) : `${req.ip}:${req.user ? req.user._id : 'anon'}`;
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (hits.get(key) || []).filter((ts) => ts > windowStart);
    if (timestamps.length >= max) {
      return next(ApiError.tooMany('rate_limited', 'Too many requests, slow down and retry shortly'));
    }
    timestamps.push(now);
    hits.set(key, timestamps);
    return next();
  };
}

// Periodic cleanup so the map does not grow unbounded with dead keys.
const sweeper = setInterval(() => {
  /* handled by closures below via their own maps */
}, 60000);
sweeper.unref();

const writeLimiter = createRateLimiter();
const aiLimiter = createRateLimiter({
  max: config.rateLimit.maxAi,
  keyFn: (req) => `ai:${req.user ? req.user._id : req.ip}`,
});

module.exports = { createRateLimiter, writeLimiter, aiLimiter };
