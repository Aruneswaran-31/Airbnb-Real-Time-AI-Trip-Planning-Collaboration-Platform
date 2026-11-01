'use strict';

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const { createServer } = require('./server');

async function main() {
  await db.connect();

  const { server } = createServer();

  await new Promise((resolve) => server.listen(config.port, resolve));

  logger.info('api listening', {
    port: config.port,
    env: config.env,
    webOrigin: config.webOrigin,
    aiEngine: config.ai.apiKey ? `llm:${config.ai.model}` : 'grounded-template',
  });
  logger.info(`API ready on http://localhost:${config.port}  |  socket.io on the same origin`);

  const shutdown = async (signal) => {
    logger.info('shutting down', { signal });
    server.close(async () => {
      await db.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('failed to start', { message: err.message, stack: err.stack });
  process.exit(1);
});
