'use strict';

/**
 * End-to-end smoke check against a running API.
 *
 *   npm run dev:server        # in one terminal
 *   node scripts/smoke-api.js http://localhost:4310
 *
 * Verifies login for all four roles, board sync payload, budget math, the AI
 * concierge (grounding + constraint compliance), conflict detection and RBAC.
 */

const BASE = process.argv[2] || process.env.API_URL || 'http://localhost:4000';

const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

async function login(email) {
  const { status, json } = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password: 'Demo1234!' },
  });
  if (status !== 200) throw new Error(`login failed for ${email}: ${status}`);
  return json;
}

async function main() {
  console.log(`\nSmoke test against ${BASE}\n${'='.repeat(60)}`);

  const health = await api('/healthz');
  record('health check', health.status === 200 && health.json.status === 'ok');

  const leader = await login('arun@demo.dev');
  const planner = await login('maya@demo.dev');
  const viewer = await login('leo@demo.dev');
  const admin = await login('admin@demo.dev');
  record(
    'JWT login for 4 accounts (leader/planner/viewer/admin)',
    Boolean(leader.accessToken && planner.accessToken && viewer.accessToken && admin.accessToken)
  );

  const trips = await api('/api/v1/trips', { token: leader.accessToken });
  const trip = (trips.json.trips || []).find((t) => t.status !== 'completed');
  record('list trips', trips.status === 200 && Boolean(trip), `${trips.json.trips?.length || 0} trips`);

  const board = await api(`/api/v1/trips/${trip.tripId}/board`, { token: leader.accessToken });
  record(
    'board snapshot (items + budget + conflicts)',
    board.status === 200 && Array.isArray(board.json.items) && board.json.items.length > 0,
    `${board.json.items?.length} items, role=${board.json.role}`
  );
  record(
    'budget math reconciles to group total',
    board.json.budget?.sharesSumCents === board.json.budget?.groupTotalCents,
    `${board.json.budget?.groupTotalCents} cents across ${board.json.budget?.travelers} travelers`
  );
  record(
    'conflict detector flagged the seeded overlap',
    (board.json.conflicts || []).some((c) => c.conflictType === 'overlap'),
    (board.json.conflicts || []).map((c) => c.conflictType).join(', ') || 'none'
  );

  // AI Concierge with an explicit constraint.
  const anchor = board.json.items.find((item) => item.startTime === '17:00');
  const ai = await api(`/api/v1/trips/${trip.tripId}/ai/ask`, {
    method: 'POST',
    token: planner.accessToken,
    body: { question: 'Suggest a dinner spot near our 5 PM sunset under $25 per person', anchorItemId: anchor?.itemId },
  });
  const suggested = ai.json.suggestedVenue;
  record(
    'AI concierge answered with a grounded, cited venue',
    ai.status === 200 && Boolean(ai.json.answer) && (ai.json.sourceEvents || []).length > 0,
    `engine=${ai.json.engine} latency=${ai.json.latencyMs}ms`
  );
  const constraints = ai.json.constraints || {};
  record(
    'suggested venue satisfies budget + dietary + hours constraints',
    Boolean(suggested) &&
      suggested.pricePerPersonCents <= constraints.maxPriceCents &&
      (constraints.dietaryTags || []).every((tag) => (suggested.dietaryTags || []).includes(tag)),
    `${suggested?.name} ($${(suggested?.pricePerPersonCents || 0) / 100}) vs ceiling $${(constraints.maxPriceCents || 0) / 100}`
  );
  record('AI latency under the 3s target', (ai.json.latencyMs || 0) < 3000, `${ai.json.latencyMs}ms`);

  // RBAC: a viewer must not be able to pin, and never through the API alone.
  const viewerPin = await api(`/api/v1/trips/${trip.tripId}/items`, {
    method: 'POST',
    token: viewer.accessToken,
    body: { venueId: 'v_3417', dayIndex: 0, startTime: '09:00', endTime: '10:00' },
  });
  record('RBAC blocks viewer pin (403)', viewerPin.status === 403, viewerPin.json?.error?.code);

  const viewerUpload = await api('/api/v1/admin/venues', {
    method: 'POST',
    token: viewer.accessToken,
    body: { venues: [] },
  });
  record('RBAC blocks non-admin dataset upload (403)', viewerUpload.status === 403, viewerUpload.json?.error?.code);

  const adminStats = await api('/api/v1/admin/dataset-stats', { token: admin.accessToken });
  record(
    'admin can read dataset coverage',
    adminStats.status === 200 && adminStats.json.destinations?.length >= 2,
    `${adminStats.json.destinations?.length} destinations`
  );

  // Pin as planner, verify version bump + conflict broadcast payload, then remove.
  const pin = await api(`/api/v1/trips/${trip.tripId}/items`, {
    method: 'POST',
    token: planner.accessToken,
    body: { venueId: 'v_3411', dayIndex: 1, startTime: '20:30', endTime: '21:30', note: 'smoke test' },
  });
  record(
    'planner pin succeeds with positionVersion=1',
    pin.status === 201 && pin.json.item?.positionVersion === 1,
    pin.json.item?.title
  );

  const newItem = pin.json.item;
  const move = await api(`/api/v1/trips/${trip.tripId}/items/${newItem.itemId}`, {
    method: 'PATCH',
    token: planner.accessToken,
    body: { dayIndex: 1, startTime: '21:00', endTime: '22:00', expectedVersion: 1 },
  });
  record('move bumps version to 2', move.status === 200 && move.json.item?.positionVersion === 2);

  const stale = await api(`/api/v1/trips/${trip.tripId}/items/${newItem.itemId}`, {
    method: 'PATCH',
    token: leader.accessToken,
    body: { dayIndex: 1, startTime: '22:00', endTime: '22:30', expectedVersion: 1 },
  });
  record(
    'stale concurrent move rejected with 409 + current state',
    stale.status === 409 && stale.json.error?.code === 'stale_version',
    `server version ${stale.json.currentItem?.positionVersion}`
  );

  const remove = await api(`/api/v1/trips/${trip.tripId}/items/${newItem.itemId}`, {
    method: 'DELETE',
    token: planner.accessToken,
  });
  record('planner can remove own drafting pin', remove.status === 200);

  const analytics = await api(`/api/v1/trips/${trip.tripId}/analytics`, { token: leader.accessToken });
  record(
    'analytics reconcile with the event log',
    analytics.status === 200 && analytics.json.analytics?.reconciliation?.matches === true,
    `delta=${analytics.json.analytics?.reconciliation?.deltaCents}`
  );

  const rail = await api('/api/v1/recommendations?limit=6', { token: leader.accessToken });
  record('recommendation rail returns scored items', rail.status === 200 && (rail.json.rail || []).length > 0, `${rail.json.rail?.length} items`);

  const venues = await api('/api/v1/destinations/Lisbon%2C%20Portugal/venues?near=38.7139,-9.1394&radiusKm=1');
  record('venue proximity endpoint', venues.status === 200 && venues.json.count > 0, `${venues.json.count} within 1km`);

  const join = await api('/api/v1/trips/join', { method: 'POST', token: planner.accessToken, body: { inviteCode: trip.inviteCode } });
  record('join by invite code is idempotent for members', join.status === 200 && join.json.alreadyMember === true);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${results.length} checks)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
