import { MongoMemoryServer } from 'mongodb-memory-server';
const m = await MongoMemoryServer.create();
console.log('URI', m.getUri());
await m.stop();
console.log('OK');
