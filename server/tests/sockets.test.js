'use strict';

/**
 * Board Sync Gateway tests: two live planners in one room.
 * Covers fan-out drift, concurrent-move conflict notification, presence, chat,
 * leader-disconnect promotion and reconnect resync.
 */

const { io: ioClient } = require('socket.io-client');

const { createServer } = require('../src/server');
const { signAccessToken } = require('../src/middleware/auth');
const Trip = require('../src/models/Trip');
const ItineraryItem = require('../src/models/ItineraryItem');
const { startDb, stopDb, clearDb, seedFixtures } = require('./helpers');

let fixtures;
let server;
let io;
let baseUrl;
const sockets = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(token, name) {
  const socket = ioClient(baseUrl, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  socket.__name = name;
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} connect timeout`)), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitFor(socket, event, { predicate = () => true, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeout);
    const handler = (msg) => {
      if (!predicate(msg)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(msg);
    };
    socket.on(event, handler);
  });
}

function waitForAny(socketList, event, { predicate = () => true, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socketList.forEach((s) => s.off(event, handler));
      reject(new Error(`timeout waiting for ${event} on any socket`));
    }, timeout);
    const handler = (msg) => {
      if (!predicate(msg)) return;
      clearTimeout(timer);
      socketList.forEach((s) => s.off(event, handler));
      resolve(msg);
    };
    socketList.forEach((s) => s.on(event, handler));
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

beforeAll(async () => {
  await startDb();
  fixtures = await seedFixtures();

  const created = createServer();
  server = created.server;
  io = created.io;
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => io.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await clearDb();
  await stopDb();
});

test('two planners join the same room and receive the full board snapshot', async () => {
  const leaderToken = signAccessToken({ ...fixtures.users.leader.toObject(), _id: fixtures.users.leader._id });
  const plannerToken = signAccessToken({ ...fixtures.users.planner.toObject(), _id: fixtures.users.planner._id });

  const leader = await connect(leaderToken, 'leader');
  const snapshotPromise = waitFor(leader, 'trip.board.snapshot');
  const leaderAck = await emitAck(leader, 'trip.join', { tripId: String(fixtures.trip._id) });
  expect(leaderAck.ok).toBe(true);

  const snapshot = await snapshotPromise;
  expect(snapshot.payload.items).toHaveLength(fixtures.items.length);
  expect(snapshot.payload.budget.groupTotalCents).toBeGreaterThan(0);
  expect(snapshot.payload.role).toBe('leader');

  const planner = await connect(plannerToken, 'planner');
  const presencePromise = waitFor(leader, 'trip.presence.update', {
    predicate: (msg) => msg.payload.action === 'joined' && msg.payload.participantCount === 2,
  });
  const plannerSnapshot = waitFor(planner, 'trip.board.snapshot');
  await emitAck(planner, 'trip.join', { tripId: String(fixtures.trip._id) });
  await plannerSnapshot;
  const presence = await presencePromise;
  expect(presence.payload.participants.map((p) => p.name)).toEqual(expect.arrayContaining(['Leader', 'Planner']));
}, 30000);

test('a pin fans out to the other client within the 100ms drift target', async () => {
  const planner = sockets.find((s) => s.__name === 'planner');
  const leader = sockets.find((s) => s.__name === 'leader');

  const updatePromise = waitFor(leader, 'trip.board.update', {
    predicate: (msg) => (msg.payload.items || []).some((i) => i.title === 'Miradouro de São Pedro de Alcântara'),
  });

  const sentAt = Date.now();
  const ack = await emitAck(planner, 'trip.board.pin', {
    tripId: String(fixtures.trip._id),
    payload: { venueId: 'v_3417', dayIndex: 3, startTime: '08:00', endTime: '09:00' },
  });
  expect(ack.ok).toBe(true);

  const update = await updatePromise;

  // Sync drift per PRD 6.1: the delay between the mutating event being applied
  // server-side and it reflecting on every other connected client. The envelope
  // carries the server emit timestamp, so this measures fan-out, not client RTT.
  const fanoutDrift = Date.now() - update.ts;
  const roundTrip = Date.now() - sentAt;
  process.stdout.write(`\n    [perf] fan-out drift ${fanoutDrift}ms (round trip incl. write: ${roundTrip}ms)\n`);

  expect(update.payload.items.length).toBeGreaterThan(fixtures.items.length);
  expect(fanoutDrift).toBeLessThan(100);
}, 30000);

test('concurrent moves on the same item resolve deterministically and notify the loser', async () => {
  const planner = sockets.find((s) => s.__name === 'planner');
  const leader = sockets.find((s) => s.__name === 'leader');

  const ack = await emitAck(planner, 'trip.board.pin', {
    tripId: String(fixtures.trip._id),
    payload: { venueId: 'v_3414', dayIndex: 3, startTime: '10:00', endTime: '11:00' },
  });
  expect(ack.ok).toBe(true);

  const item = await ItineraryItem.findById(ack.itemId).lean();
  expect(item.positionVersion).toBe(1);

  // The losing client (whichever it turns out to be) must receive the conflict.
  const conflictPromise = waitForAny([planner, leader], 'trip.board.conflict', {
    predicate: (msg) => msg.payload.conflictType === 'version',
  });

  // Both planners submit with the same expectedVersion at the same instant.
  const results = await Promise.all([
    emitAck(planner, 'trip.board.move', {
      tripId: String(fixtures.trip._id),
      payload: { itemId: ack.itemId, dayIndex: 3, startTime: '11:00', endTime: '12:00', expectedVersion: 1 },
    }),
    emitAck(leader, 'trip.board.move', {
      tripId: String(fixtures.trip._id),
      payload: { itemId: ack.itemId, dayIndex: 3, startTime: '13:00', endTime: '14:00', expectedVersion: 1 },
    }),
  ]);

  const accepted = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);
  expect(accepted).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].code).toBe('stale_version');

  const conflict = await conflictPromise;
  expect(conflict.payload.currentVersion).toBeGreaterThanOrEqual(2);
  expect(conflict.payload.currentItem).toBeTruthy();

  // Server and stored state agree after the dust settles.
  const final = await ItineraryItem.findById(ack.itemId).lean();
  expect(final.positionVersion).toBe(2);
  expect([accepted[0].positionVersion]).toEqual([2]);
}, 30000);

test('chat messages and typing indicators fan out', async () => {
  const planner = sockets.find((s) => s.__name === 'planner');
  const leader = sockets.find((s) => s.__name === 'leader');

  const typingPromise = waitFor(leader, 'trip.chat.typing');
  planner.emit('trip.chat.typing', { tripId: String(fixtures.trip._id), payload: { isTyping: true } });
  const typing = await typingPromise;
  expect(typing.payload.isTyping).toBe(true);

  const messagePromise = waitFor(leader, 'trip.chat.message', {
    predicate: (msg) => msg.payload.message.body.includes('booking the tram'),
  });
  const ack = await emitAck(planner, 'trip.chat.send', {
    tripId: String(fixtures.trip._id),
    payload: { body: 'I am booking the tram for day 2' },
  });
  expect(ack.ok).toBe(true);
  const message = await messagePromise;
  expect(message.payload.message.authorName).toBe('Planner');
}, 30000);

test('sync ping returns a pong with server timing', async () => {
  const planner = sockets.find((s) => s.__name === 'planner');
  const pongPromise = waitFor(planner, 'trip.sync.pong');
  planner.emit('trip.sync.ping', { tripId: String(fixtures.trip._id), payload: { clientSentAt: Date.now() } });
  const pong = await pongPromise;
  expect(pong.payload.serverReceivedAt).toBeGreaterThan(0);
}, 20000);

test('leader disconnect promotes the longest-standing online planner', async () => {
  const leader = sockets.find((s) => s.__name === 'leader');
  const planner = sockets.find((s) => s.__name === 'planner');

  const promotedPromise = waitFor(planner, 'trip.leader.state', {
    predicate: (msg) => msg.payload.promoted === true,
  });

  leader.close();
  const promoted = await promotedPromise;
  expect(promoted.payload.leaderDisconnected).toBe(true);
  expect(promoted.payload.promotedTo.name).toBe('Planner');

  const trip = await Trip.findById(fixtures.trip._id).lean();
  expect(String(trip.leaderUserId)).toBe(String(fixtures.users.planner._id));
}, 30000);

test('a reconnecting client receives a fresh snapshot with the current board', async () => {
  const plannerToken = signAccessToken({ ...fixtures.users.planner.toObject(), _id: fixtures.users.planner._id });
  const reconnected = await connect(plannerToken, 'planner-reconnect');

  const snapshotPromise = waitFor(reconnected, 'trip.board.snapshot');
  await emitAck(reconnected, 'trip.join', { tripId: String(fixtures.trip._id) });
  const snapshot = await snapshotPromise;

  expect(snapshot.payload.items.length).toBeGreaterThan(0);
  expect(snapshot.payload.role).toBe('leader'); // promoted after the disconnect test
  expect(snapshot.payload.presence.length).toBeGreaterThan(0);
  await sleep(50);
}, 30000);
