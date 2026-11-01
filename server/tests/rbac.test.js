'use strict';

const request = require('supertest');

const { createApp } = require('../src/app');
const { startDb, stopDb, clearDb, seedFixtures, PASSWORD } = require('./helpers');

const app = createApp();

let fixtures;
let tokens;

async function login(email) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

beforeAll(async () => {
  await startDb();
  fixtures = await seedFixtures();
  tokens = {
    leader: await login('leader@test.dev'),
    planner: await login('planner@test.dev'),
    viewer: await login('viewer@test.dev'),
    admin: await login('admin@test.dev'),
  };
});

afterAll(async () => {
  await clearDb();
  await stopDb();
});

describe('authentication', () => {
  test('rejects unauthenticated access to a trip board', async () => {
    const res = await request(app).get(`/api/v1/trips/${fixtures.trip._id}/board`);
    expect(res.status).toBe(401);
  });

  test('rejects an invalid token', async () => {
    const res = await request(app).get('/api/v1/trips').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  test('refresh tokens rotate a working session', async () => {
    // A dedicated account: logging out bumps tokenVersion and would invalidate
    // the shared planner token used by the role tests below.
    const { createUser } = require('./helpers');
    await createUser({ email: 'refresh@test.dev', name: 'Refresh' });

    const login = await request(app).post('/api/v1/auth/login').send({ email: 'refresh@test.dev', password: PASSWORD });
    const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();

    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`);
    expect(logout.status).toBe(200);

    const afterRevoke = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: refreshed.body.refreshToken });
    expect(afterRevoke.status).toBe(401);
  });
});

describe('role enforcement (server-side)', () => {
  const pinBody = { venueId: 'v_3417', dayIndex: 0, startTime: '09:00', endTime: '10:00' };

  test('Viewer cannot pin (403)', async () => {
    const res = await request(app)
      .post(`/api/v1/trips/${fixtures.trip._id}/items`)
      .set('Authorization', `Bearer ${tokens.viewer}`)
      .send(pinBody);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('insufficient_role');
  });

  test('Viewer cannot ask the AI concierge', async () => {
    const res = await request(app)
      .post(`/api/v1/trips/${fixtures.trip._id}/ai/ask`)
      .set('Authorization', `Bearer ${tokens.viewer}`)
      .send({ question: 'Suggest a dinner under $20' });
    expect(res.status).toBe(403);
  });

  test('Viewer can read the board', async () => {
    const res = await request(app)
      .get(`/api/v1/trips/${fixtures.trip._id}/board`)
      .set('Authorization', `Bearer ${tokens.viewer}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  test('Planner cannot lock an item (Leader only)', async () => {
    const item = fixtures.items[0];
    const res = await request(app)
      .post(`/api/v1/trips/${fixtures.trip._id}/items/${item._id}/lock`)
      .set('Authorization', `Bearer ${tokens.planner}`);
    expect(res.status).toBe(403);
  });

  test('Leader can lock an item and the state machine applies', async () => {
    const item = fixtures.items[0];
    const res = await request(app)
      .post(`/api/v1/trips/${fixtures.trip._id}/items/${item._id}/lock`)
      .set('Authorization', `Bearer ${tokens.leader}`);
    expect(res.status).toBe(200);
    expect(res.body.item.lifecycleStage).toBe('locked');
  });

  test('Planner can unpin only after the Leader unlocks', async () => {
    const item = fixtures.items[0];
    const blocked = await request(app)
      .delete(`/api/v1/trips/${fixtures.trip._id}/items/${item._id}`)
      .set('Authorization', `Bearer ${tokens.planner}`);
    expect(blocked.status).toBe(403);

    await request(app)
      .post(`/api/v1/trips/${fixtures.trip._id}/items/${item._id}/unlock`)
      .set('Authorization', `Bearer ${tokens.leader}`);
  });

  test('non-member cannot read a trip', async () => {
    const { createUser } = require('./helpers');
    await createUser({ email: 'outsider@test.dev', name: 'Outsider' });
    const outsiderToken = await login('outsider@test.dev');
    const res = await request(app)
      .get(`/api/v1/trips/${fixtures.trip._id}/board`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_a_member');
  });

  test('Planner cannot manage the venue dataset', async () => {
    const res = await request(app)
      .post('/api/v1/admin/venues')
      .set('Authorization', `Bearer ${tokens.planner}`)
      .send([{ name: 'x' }]);
    expect(res.status).toBe(403);
  });

  test('Admin dataset upload rejects invalid records with field-level errors', async () => {
    const res = await request(app)
      .post('/api/v1/admin/venues')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send([
        {
          name: 'Broken Venue',
          destination: 'Lisbon, Portugal',
          category: 'food',
          pricePerPerson: -5,
          dietaryTags: ['carnivore'],
          coordinates: { lat: 200, lng: -9.1 },
          hours: { open: '25:00', close: '10:00' },
          description: '',
        },
      ]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_dataset');
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['pricePerPerson', 'dietaryTags', 'coordinates', 'hours', 'description']));
  });

  test('Admin dataset upload accepts a valid venue', async () => {
    const res = await request(app)
      .post('/api/v1/admin/venues')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send([
        {
          venueId: 'v_admin_1',
          name: 'Admin Uploaded Rooftop',
          destination: 'Lisbon, Portugal',
          category: 'activity',
          pricePerPerson: 19,
          dietaryTags: ['vegetarian'],
          coordinates: { lat: 38.71, lng: -9.14 },
          hours: { open: '17:00', close: '23:00' },
          rating: 4.4,
          description: 'A rooftop with river views and vegetarian snacks, uploaded through the admin endpoint.',
        },
      ]);
    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(1);
  });
});
