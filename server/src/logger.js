'use strict';

/**
 * Minimal structured logger (JSON lines) with per-room correlation support.
 * Keeps logging dependency-free and greppable for the observability requirement.
 */

const config = require('./config');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const threshold = LEVELS[config.logLevel] || LEVELS.info;

function emit(level, message, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = {
    level,
    ts: new Date().toISOString(),
    msg: message,
    ...fields,
  };
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

function child(base = {}) {
  return {
    trace: (m, f) => emit('trace', m, { ...base, ...f }),
    debug: (m, f) => emit('debug', m, { ...base, ...f }),
    info: (m, f) => emit('info', m, { ...base, ...f }),
    warn: (m, f) => emit('warn', m, { ...base, ...f }),
    error: (m, f) => emit('error', m, { ...base, ...f }),
    child: (more) => child({ ...base, ...more }),
  };
}

module.exports = child();
module.exports.child = child;
