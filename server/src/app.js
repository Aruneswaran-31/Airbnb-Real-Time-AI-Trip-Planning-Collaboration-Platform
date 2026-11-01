'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const { errorHandler, notFoundHandler } = require('./middleware/errors');
const { isAllowedOrigin } = require('./utils/origin');

const authRoutes = require('./routes/auth');
const tripRoutes = require('./routes/trips');
const venueRoutes = require('./routes/venues');
const recommendationRoutes = require('./routes/recommendations');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');

function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: isAllowedOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));

  // Lightweight request log (structured, excludes bodies so no secrets leak).
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/healthz') || req.path.startsWith('/readyz')) return;
      logger.debug('http', {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Date.now() - startedAt,
      });
    });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'trip-war-room-api', uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get('/readyz', async (_req, res) => {
    const mongo = await db.ping();
    res.status(mongo ? 200 : 503).json({
      status: mongo ? 'ready' : 'degraded',
      checks: { mongo, syncGateway: 'ok', aiEngine: config.ai.apiKey ? 'llm' : 'grounded-template' },
    });
  });

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/trips', tripRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use('/api/v1/dashboard', dashboardRoutes);
  app.use('/api/v1/recommendations', recommendationRoutes);
  // Public catalog routes are mounted last so they never shadow an API path.
  app.use('/api/v1', venueRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
