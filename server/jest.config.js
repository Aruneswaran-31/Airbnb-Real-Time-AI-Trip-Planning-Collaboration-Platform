'use strict';

module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testTimeout: 120000,
  verbose: true,
};
