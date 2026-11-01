'use strict';

const http = require('http');
const { Server } = require('socket.io');

const { createApp } = require('./app');
const gateway = require('./realtime/gateway');
const { allowedOrigins } = require('./utils/origin');

function createServer() {
  const app = createApp();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: allowedOrigins(), credentials: true },
    maxHttpBufferSize: 1_000_000,
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });

  gateway.register(io);

  return { app, server, io };
}

module.exports = { createServer };
