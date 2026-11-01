'use strict';

require('dotenv').config();

const path = require('path');

const env = process.env.NODE_ENV || 'development';

function pick(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const config = {
  env,
  port: Number(pick('PORT', 4000)),
  webOrigin: pick('WEB_ORIGIN', 'http://localhost:5173'),
  logLevel: pick('LOG_LEVEL', 'info'),

  jwt: {
    accessSecret: pick(
      'JWT_ACCESS_SECRET',
      env === 'production' ? null : 'dev-only-access-secret-change-me'
    ),
    refreshSecret: pick(
      'JWT_REFRESH_SECRET',
      env === 'production' ? null : 'dev-only-refresh-secret-change-me'
    ),
    accessTtl: pick('JWT_ACCESS_TTL', '45m'),
    refreshTtl: pick('JWT_REFRESH_TTL', '7d'),
    issuer: 'trip-war-room',
  },

  mongo: {
    uri: pick('MONGODB_URI', null),
    dbName: pick('MONGODB_DB', env === 'test' ? 'trip_war_room_test' : 'trip_war_room'),
    // Used by the zero-install local fallback (mongodb-memory-server).
    downloadDir: path.join(__dirname, '..', '.cache', 'mongo-bin'),
    dataDir: path.join(__dirname, '..', '.data', 'mongo'),
  },

  ai: {
    apiKey: pick('AI_API_KEY', pick('OPENAI_API_KEY', null)),
    baseUrl: pick('AI_BASE_URL', 'https://api.openai.com/v1'),
    model: pick('AI_MODEL', 'gpt-4o-mini'),
    timeoutMs: Number(pick('AI_TIMEOUT_MS', 3500)),
  },

  constraints: {
    defaultRadiusKm: Number(pick('DEFAULT_RADIUS_KM', 2)),
    defaultHoursBufferMinutes: Number(pick('DEFAULT_HOURS_BUFFER_MINUTES', 30)),
    weights: { proximity: 0.4, rating: 0.3, budgetHeadroom: 0.3 },
  },

  room: {
    defaultMaxParticipants: 8,
    hardMaxParticipants: 50,
    inviteCodeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  },

  budget: {
    categories: ['lodging', 'food', 'activity', 'transport', 'other'],
  },

  rateLimit: {
    windowMs: 60 * 1000,
    maxWrites: 120,
    maxAi: 20,
  },
};

if (env === 'production') {
  const missing = [];
  if (!config.jwt.accessSecret) missing.push('JWT_ACCESS_SECRET');
  if (!config.jwt.refreshSecret) missing.push('JWT_REFRESH_SECRET');
  if (missing.length) {
    throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
  }
}

module.exports = config;
