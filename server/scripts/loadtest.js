'use strict';

/**
 * Local load test / performance evidence.
 *
 *   node scripts/loadtest.js http://localhost:4310 6
 *
 * Creates N scripted travelers in one Trip Room, gets them to pin/move/chat
 * simultaneously, and reports measured:
 *   - board fan-out drift (server emit -> peer receive): p50 / p95
 *   - API latency for board reads: p50 / p95
 *   - AI Concierge latency: p50 / p95
 *   - concurrent-move conflict handling (must reject exactly one writer)
 */

const { io: ioClient } = require('socket.io-client');

const BASE = process.argv[2] || 'http://localhost:4000';
const CLIENTS = Number(process.argv[3] || 6);
const PASSWORD = 'LoadTest123!';

const percentiles = (values) => {
  if (!values.length) return { p50: 0, p95: 0, min: 0, max: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    p50: Math.round(at(50)),
    p95: Math.round(at(95)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    n: sorted.length,
  };
};

async function api(path, { method = 'GET', token, body } = {}) {
  const startedAt = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, ms: Date.now() - startedAt };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 10000);
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

const join = (socket, tripId) => new Promise((resolve) => socket.emit('trip.join', { tripId }, resolve));
const emitAck = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

async function main() {
  console.log(`\nLoad test: ${CLIENTS} travelers against ${BASE}\n${'='.repeat(58)}`);

  const leader = await api('/api/v1/auth/login', { method: 'POST', body: { email: 'arun@demo.dev', password: 'Demo1234!' } });
  if (leader.status !== 200) throw new Error('Seed the database first (npm run seed)');

  // A dedicated high-capacity room so the load test never collides with the
  // demo room's participant cap.
  const created = await api('/api/v1/trips', {
    method: 'POST',
    token: leader.json.accessToken,
    body: {
      destination: 'Lisbon, Portugal',
      startDate: '2027-05-03',
      endDate: '2027-05-08',
      totalBudget: 50000,
      maxParticipants: 50,
    },
  });
  if (created.status !== 201) throw new Error(`load-test room create failed: ${created.status}`);
  const trip = {
    tripId: created.json.tripId,
    inviteCode: created.json.inviteCode,
    destination: created.json.destination,
  };
  console.log(`Room: ${trip.destination} (${trip.tripId})\n`);

  const stamp = Date.now().toString().slice(-5);
  const travelers = [];

  for (let i = 0; i < CLIENTS; i += 1) {
    const email = `load${i}-${stamp}@demo.dev`;
    const registered = await api('/api/v1/auth/register', {
      method: 'POST',
      body: { email, password: PASSWORD, displayName: `Load Traveler ${i + 1}` },
    });
    if (registered.status !== 201) throw new Error(`register failed: ${registered.status}`);
    const joined = await api('/api/v1/trips/join', {
      method: 'POST',
      token: registered.json.accessToken,
      body: { inviteCode: trip.inviteCode },
    });
    if (joined.status !== 200) throw new Error(`join failed: ${joined.status}`);
    travelers.push({ email, token: registered.json.accessToken, name: `Load Traveler ${i + 1}` });
  }

  const sockets = await Promise.all(travelers.map((t) => connect(t.token)));
  await Promise.all(sockets.map((socket) => join(socket, trip.tripId)));
  console.log(`${CLIENTS} travelers connected and joined.`);

  // ------------------------------------------------------------------ drift
  const driftSamples = [];
  const pushSamples = [];
  sockets.forEach((socket) => {
    socket.on('trip.board.update', (msg) => {
      driftSamples.push(Date.now() - msg.ts);
    });
  });

  const venues = ['v_3391', 'v_3392', 'v_3410', 'v_3413', 'v_3414', 'v_3416'];
  for (let i = 0; i < sockets.length; i += 1) {
    const startedAt = Date.now();
    const ack = await emitAck(sockets[i], 'trip.board.pin', {
      tripId: trip.tripId,
      payload: {
        venueId: venues[i % venues.length],
        dayIndex: 4,
        startTime: `${String(8 + i).padStart(2, '0')}:00`,
        endTime: `${String(8 + i).padStart(2, '0')}:45`,
      },
    });
    pushSamples.push(Date.now() - startedAt);
    if (!ack.ok) console.warn(`  pin ${i} rejected: ${ack.code}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 600));

  // ------------------------------------------------------ concurrent moves
  const board = await api(`/api/v1/trips/${trip.tripId}/board`, { token: travelers[0].token });
  const target = board.json.items.find((item) => item.venueId === venues[0]);
  let conflictResults = { accepted: 0, rejected: 0 };

  if (target && sockets.length >= 2) {
    const args = sockets.slice(0, 4).map((socket, index) => ({
      socket,
      started: Date.now(),
      promise: emitAck(socket, 'trip.board.move', {
        tripId: trip.tripId,
        payload: {
          itemId: target.itemId,
          dayIndex: 4,
          startTime: `1${index}:00`,
          endTime: `1${index}:45`,
          expectedVersion: target.positionVersion,
        },
      }),
    }));
    for (const arg of args) pushSamples.push(Date.now() - arg.started);
    const results = await Promise.all(args.map((a) => a.promise));
    conflictResults = {
      accepted: results.filter((r) => r.ok).length,
      rejected: results.filter((r) => !r.ok).length,
    };
  }

  // ------------------------------------------------------------ API latency
  const apiSamples = [];
  for (let i = 0; i < 20; i += 1) {
    const res = await api(`/api/v1/trips/${trip.tripId}/board`, { token: travelers[i % travelers.length].token });
    apiSamples.push(res.ms);
  }

  // -------------------------------------------------------------- AI latency
  const aiSamples = [];
  const questions = [
    'Suggest a dinner under $25 near our 5 PM sunset',
    'Find a vegetarian lunch under $20',
    'Recommend an activity under $15 at 10:00',
    'Where can we eat gluten-free under $30?',
    'Suggest a cheap breakfast under $10',
    'Find a museum under $12 at 14:00',
  ];
  for (let i = 0; i < questions.length; i += 1) {
    const res = await api(`/api/v1/trips/${trip.tripId}/ai/ask`, {
      method: 'POST',
      token: travelers[i % travelers.length].token,
      body: { question: questions[i] },
    });
    if (res.status === 200) aiSamples.push(res.json.latencyMs);
    else console.warn(`  ai ask failed: ${res.status} ${res.json.error?.code}`);
  }

  // ---------------------------------------------------------------- chat load
  await Promise.all(
    sockets.slice(0, 4).map((socket, index) =>
      emitAck(socket, 'trip.chat.send', { tripId: trip.tripId, payload: { body: `Load test message ${index}` } })
    )
  );

  const drift = percentiles(driftSamples);
  const serverWrite = percentiles(pushSamples);
  const apiLatency = percentiles(apiSamples);
  const aiLatency = percentiles(aiSamples);

  console.log('\n--- Results (milliseconds) ---');
  console.log(`Board fan-out drift : p50 ${drift.p50}  p95 ${drift.p95}  max ${drift.max}  (target p95 < 100)`);
  console.log(`Socket mutation RTT : p50 ${serverWrite.p50}  p95 ${serverWrite.p95}  max ${serverWrite.max}`);
  console.log(`API board latency   : p50 ${apiLatency.p50}  p95 ${apiLatency.p95}  max ${apiLatency.max}  (target p95 < 200)`);
  console.log(`AI concierge latency: p50 ${aiLatency.p50}  p95 ${aiLatency.p95}  max ${aiLatency.max}  (target p95 < 3000)`);
  console.log(`Concurrent moves    : ${conflictResults.accepted} accepted, ${conflictResults.rejected} rejected (expected 1 accepted)`);
  console.log(`Samples             : drift ${drift.n}, api ${apiLatency.n}, ai ${aiLatency.n}\n`);

  sockets.forEach((socket) => socket.close());
  process.exit(0);
}

main().catch((err) => {
  console.error('load test failed:', err);
  process.exit(1);
});
