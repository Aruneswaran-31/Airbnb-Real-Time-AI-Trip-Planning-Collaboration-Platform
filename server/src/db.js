'use strict';

const fs = require('fs');
const mongoose = require('mongoose');
const config = require('./config');
const logger = require('./logger');

let memoryServer = null;

/**
 * Connect to MongoDB.
 *
 * - If MONGODB_URI is provided (or a uri argument is given) that database is used.
 * - Otherwise, in non-production environments, a local MongoDB instance is started
 *   with mongodb-memory-server and persisted under server/.data/mongo so the
 *   project runs with zero infrastructure installs.
 */
async function connect({ uri, persist = config.env !== 'test' } = {}) {
  const target = uri || config.mongo.uri;
  if (target) {
    await mongoose.connect(target, { dbName: config.mongo.dbName });
    logger.info('mongodb connected', { uri: target.replace(/\/\/.*@/, '//***@'), mode: 'external' });
    return { uri: target, memory: false };
  }

  if (config.env === 'production') {
    throw new Error('MONGODB_URI must be set in production');
  }

  // Embedded startup can be slow on first run / cold disks; give it room.
  if (!process.env.MONGOMS_LAUNCH_TIMEOUT) process.env.MONGOMS_LAUNCH_TIMEOUT = '90000';
  if (!process.env.MONGOMS_DOWNLOAD_DIR) process.env.MONGOMS_DOWNLOAD_DIR = config.mongo.downloadDir;

  const { MongoMemoryServer } = require('mongodb-memory-server');
  const instance = {};
  if (persist) {
    fs.mkdirSync(config.mongo.dataDir, { recursive: true });
    instance.dbPath = config.mongo.dataDir;
    instance.storageEngine = 'wiredTiger';
  }

  memoryServer = await MongoMemoryServer.create({
    binary: { downloadDir: config.mongo.downloadDir },
    instance,
  });
  const memUri = memoryServer.getUri();
  await mongoose.connect(memUri, { dbName: config.mongo.dbName });
  logger.info('mongodb connected', { mode: 'embedded', uri: memUri, persisted: persist });
  return { uri: memUri, memory: true };
}

async function disconnect() {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

async function ping() {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
}

module.exports = { connect, disconnect, ping };
