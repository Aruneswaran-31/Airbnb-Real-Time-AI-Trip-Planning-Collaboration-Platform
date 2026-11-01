'use strict';

const config = require('../config');

/**
 * In production only the configured web origin is allowed. In development any
 * loopback origin is accepted so the Vite dev server can run on any free port
 * (a busy port must never break the realtime layer).
 */
function isAllowedOrigin(origin, callback) {
  const done = typeof callback === 'function' ? callback : null;
  const allow = (result) => (done ? done(result ? null : new Error(`Origin ${origin} is not allowed by CORS`), result) : result);

  if (!origin) return allow(true);
  if (origin === config.webOrigin) return allow(true);

  if (config.env !== 'production') {
    try {
      const { hostname, protocol } = new URL(origin);
      if (protocol === 'http:' || protocol === 'https:') {
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return allow(true);
      }
    } catch {
      return allow(false);
    }
  }

  return allow(false);
}

/** Socket.io expects an array of allowed origins. */
function allowedOrigins() {
  if (config.env === 'production') return [config.webOrigin];
  return [config.webOrigin, /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/];
}

module.exports = { isAllowedOrigin, allowedOrigins };
