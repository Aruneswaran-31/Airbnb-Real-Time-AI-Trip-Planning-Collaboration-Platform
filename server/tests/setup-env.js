'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGOMS_LAUNCH_TIMEOUT = '120000';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.AI_API_KEY = '';
