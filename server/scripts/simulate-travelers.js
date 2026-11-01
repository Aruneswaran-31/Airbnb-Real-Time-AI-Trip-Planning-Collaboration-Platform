'use strict';

/**
 * Generates realistic interaction data through the real REST pipeline.
 *
 *   node scripts/simulate-travelers.js http://localhost:4310
 *
 * Creates six traveler personas with clear preferences (categories, dietary
 * tags, budget), has them join a shared "Recommender Lab" trip and pin venues
 * that match their taste. Those pins are real Interaction records, which the
 * offline trainer then evaluates against a held-out slice.
 */

const BASE = process.argv[2] || 'http://localhost:4000';
const PASSWORD = 'Simulate123!';

const PERSONAS = [
  { name: 'Foodie Fernanda', categories: ['food'], dietary: ['vegetarian'], budgetCents: 3000 },
  { name: 'Vegan Vikram', categories: ['food'], dietary: ['vegan'], budgetCents: 2500 },
  { name: 'Museum Mira', categories: ['activity'], dietary: [], budgetCents: 1500 },
  { name: 'Budget Bella', categories: ['food', 'transport'], dietary: [], budgetCents: 1000 },
  { name: 'Luxury Lucas', categories: ['lodging', 'food'], dietary: [], budgetCents: 15000 },
  { name: 'Active Aria', categories: ['activity'], dietary: [], budgetCents: 4000 },
];

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function pickVenues(venues, persona, count) {
  const scored = venues
    .map((venue) => {
      let score = 0;
      if (persona.categories.includes(venue.category)) score += 5;
      if ((venue.dietaryTags || []).some((tag) => persona.dietary.includes(tag))) score += 4;
      if (venue.pricePerPersonCents <= persona.budgetCents) score += 2;
      score += (venue.rating || 0) / 5;
      return { venue, score };
    })
    .sort((a, b) => b.score - a.score || a.venue.venueId.localeCompare(b.venue.venueId));

  const chosen = [];
  const perCategory = {};
  for (const entry of scored) {
    const count4Category = perCategory[entry.venue.category] || 0;
    if (count4Category >= Math.ceil(count / persona.categories.length)) continue;
    chosen.push(entry.venue);
    perCategory[entry.venue.category] = count4Category + 1;
    if (chosen.length >= count) break;
  }
  return chosen;
}

async function main() {
  console.log(`\nSimulating travelers against ${BASE}\n${'='.repeat(56)}`);

  const stamp = Date.now().toString().slice(-5);
  const organizer = await api('/api/v1/auth/register', {
    method: 'POST',
    body: { email: `organizer-${stamp}@demo.dev`, password: PASSWORD, displayName: 'Recommender Lab Organizer' },
  });
  if (organizer.status !== 201) throw new Error(`organizer register failed: ${organizer.status}`);

  const tripResponse = await api('/api/v1/trips', {
    method: 'POST',
    token: organizer.json.accessToken,
    body: {
      destination: 'Lisbon, Portugal',
      startDate: '2027-03-01',
      endDate: '2027-03-06',
      totalBudget: 20000,
      maxParticipants: 20,
    },
  });
  if (tripResponse.status !== 201) throw new Error(`trip create failed: ${tripResponse.status}`);
  const tripId = tripResponse.json.tripId;
  const inviteCode = tripResponse.json.inviteCode;

  const catalog = await api('/api/v1/destinations/Lisbon%2C%20Portugal/venues');
  if (catalog.status !== 200) throw new Error(`catalog failed: ${catalog.status}`);
  const venues = catalog.json.venues;

  let pinned = 0;
  for (let p = 0; p < PERSONAS.length; p += 1) {
    const persona = PERSONAS[p];
    const email = `persona${p}-${stamp}@demo.dev`;
    const register = await api('/api/v1/auth/register', {
      method: 'POST',
      body: { email, password: PASSWORD, displayName: persona.name, dietaryTags: persona.dietary },
    });
    if (register.status !== 201) throw new Error(`persona register failed: ${register.status}`);
    const token = register.json.accessToken;

    const join = await api('/api/v1/trips/join', { method: 'POST', token, body: { inviteCode } });
    if (join.status !== 200) throw new Error(`join failed: ${join.status}`);

    const picks = pickVenues(venues, persona, 6);
    for (let i = 0; i < picks.length; i += 1) {
      const dayIndex = Math.floor(i / 4);
      const hour = 8 + (i % 4) * 3;
      const result = await api(`/api/v1/trips/${tripId}/items`, {
        method: 'POST',
        token,
        body: {
          venueId: picks[i].venueId,
          dayIndex,
          startTime: `${String(hour).padStart(2, '0')}:00`,
          endTime: `${String(hour + 1).padStart(2, '0')}:30`,
        },
      });
      if (result.status === 201) pinned += 1;
      else if (result.status === 409) {
        // Slot collision with another persona's pin is fine — try a later hour.
        const retryHour = hour + 2;
        const retry = await api(`/api/v1/trips/${tripId}/items`, {
          method: 'POST',
          token,
          body: {
            venueId: picks[i].venueId,
            dayIndex: dayIndex + 3,
            startTime: `${String(retryHour % 22).padStart(2, '0')}:00`,
            endTime: `${String((retryHour % 22) + 1).padStart(2, '0')}:30`,
          },
        });
        if (retry.status === 201) pinned += 1;
      }
    }
    // Browsing behaviour: save a few more venues in the same interests and open
    // (but skip) a few outside them — this is what a real traveler's history looks like.
    const pickedIds = new Set(picks.map((v) => v.venueId));
    const sameCategory = venues
      .filter((v) => !pickedIds.has(v.venueId) && persona.categories.includes(v.category))
      .slice(0, 4);
    const crossCategory = venues
      .filter((v) => !pickedIds.has(v.venueId) && !persona.categories.includes(v.category))
      .slice(0, 4);

    for (const venue of sameCategory) {
      await api('/api/v1/recommendations/feedback', {
        method: 'POST',
        token,
        body: { venueId: venue.venueId, liked: true },
      });
    }
    for (const venue of crossCategory) {
      await api('/api/v1/recommendations/feedback', {
        method: 'POST',
        token,
        body: { venueId: venue.venueId, liked: false },
      });
    }

    console.log(
      `${persona.name}: ${picks.length} pins, ${sameCategory.length} saves, ${crossCategory.length} views ` +
        `(${picks.map((v) => v.venueId).join(', ')})`
    );
  }

  // Give the seeded demo accounts coherent histories too, so the dashboard rail
  // and the offline evaluation reflect declared preferences.
  const demoLikes = {
    'arun@demo.dev': ['v_3392', 'v_3397', 'v_3410', 'v_3414', 'v_3419'],
    'maya@demo.dev': ['v_3397', 'v_3418', 'v_3392', 'v_3411'],
    'leo@demo.dev': ['v_3432', 'v_3441', 'v_3413'],
  };
  for (const [email, venueIds] of Object.entries(demoLikes)) {
    const login = await api('/api/v1/auth/login', { method: 'POST', body: { email, password: 'Demo1234!' } });
    if (login.status !== 200) continue;
    for (const venueId of venueIds) {
      await api('/api/v1/recommendations/feedback', {
        method: 'POST',
        token: login.json.accessToken,
        body: { venueId, liked: true },
      });
    }
    console.log(`Demo account ${email}: ${venueIds.length} saved venues`);
  }

  console.log(`\nGenerated ${pinned} pin interactions in trip ${tripId}.`);
  console.log('Now stop the API and run `npm run train` to retrain + evaluate the recommender.\n');
}

main().catch((err) => {
  console.error('simulation failed:', err);
  process.exit(1);
});
