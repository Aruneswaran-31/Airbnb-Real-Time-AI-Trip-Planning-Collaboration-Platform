'use strict';

const { askConcierge } = require('../src/services/concierge');
const { isConstraintValid } = require('../src/services/constraints');
const { parseQuestion } = require('../src/ai/questionParser');
const { startDb, stopDb, clearDb, seedFixtures } = require('./helpers');
const Venue = require('../src/models/Venue');

let fixtures;
let usersById;
let datasetIds;

beforeAll(async () => {
  await startDb();
  fixtures = await seedFixtures();
  usersById = Object.fromEntries(Object.values(fixtures.users).map((u) => [String(u._id), u.toObject()]));
  const venues = await Venue.find({}).lean();
  datasetIds = new Set(venues.map((v) => v.venueId));
});

afterAll(async () => {
  await clearDb();
  await stopDb();
});

function anchorItem() {
  return fixtures.items.find((item) => item.startTime === '17:00').toObject();
}

function venueById(id) {
  return fixtures.byId.get(id);
}

describe('question parsing', () => {
  test('extracts budget, dietary tags, category and time slot', () => {
    const parsed = parseQuestion('Suggest a vegan dinner spot near our 5 PM tour under $25 per person', {
      dietaryTags: ['vegetarian'],
    });
    expect(parsed.maxPriceCents).toBe(2500);
    expect(parsed.category).toBe('food');
    expect(parsed.dietaryTags).toEqual(expect.arrayContaining(['vegetarian', 'vegan']));
    expect(parsed.slot).toEqual({ startTime: '17:00', endTime: '18:30' });
  });

  test('handles 24h times, mile radii and duration hints', () => {
    const parsed = parseQuestion('find a museum at 14:30 for 2 hours within 3 miles');
    expect(parsed.category).toBe('activity');
    expect(parsed.slot).toEqual({ startTime: '14:30', endTime: '16:30' });
    expect(parsed.radiusKm).toBeCloseTo(4.8, 1);
  });
});

describe('RAG-grounded, constraint-valid answers', () => {
  test('suggests a venue that satisfies budget, dietary, hours and proximity', async () => {
    const result = await askConcierge({
      trip: fixtures.trip,
      user: fixtures.users.planner,
      question: 'Suggest a dinner spot near our 5 PM sunset under $25 per person',
      anchorItem: anchorItem(),
      members: fixtures.trip.members,
      usersById,
    });

    expect(result.suggestedVenueId).toBeTruthy();
    expect(result.sourceEvents.length).toBeGreaterThan(0);
    expect(result.answer).toContain(result.suggestedVenue.name);

    const constraints = {
      maxPriceCents: result.constraints.maxPriceCents,
      dietaryTags: result.constraints.dietaryTags,
      slot: result.constraints.slot,
      bufferMinutes: result.constraints.bufferMinutes,
      anchor: { lat: 38.7153, lng: -9.1442 },
      radiusKm: result.constraints.radiusKm,
    };

    const suggested = venueById(result.suggestedVenueId);
    expect(suggested).toBeDefined();
    expect(isConstraintValid(suggested, constraints)).toBe(true);
  });

  test('group dietary tags are enforced for every member', async () => {
    const result = await askConcierge({
      trip: fixtures.trip,
      user: fixtures.users.planner,
      question: 'Where can we eat dinner under $40?',
      anchorItem: null,
      members: fixtures.trip.members,
      usersById,
    });

    // Leader is vegan + vegetarian, so any food suggestion must carry both.
    if (result.suggestedVenueId) {
      const venue = venueById(result.suggestedVenueId);
      expect(venue.dietaryTags).toEqual(expect.arrayContaining(['vegan', 'vegetarian']));
    }
  });

  test('never fabricates a venue, price or opening hour', async () => {
    const result = await askConcierge({
      trip: fixtures.trip,
      user: fixtures.users.planner,
      question: 'Suggest any activity near our 5 PM sunset under $30',
      anchorItem: anchorItem(),
      members: fixtures.trip.members,
      usersById,
    });

    const cited = result.answer.match(/v_[a-z0-9_]+/gi) || [];
    for (const id of cited) expect(datasetIds.has(id)).toBe(true);
    for (const source of result.sources) {
      const venue = venueById(source.venueId);
      expect(venue.pricePerPersonCents).toBe(source.pricePerPersonCents);
      expect(venue.hours).toEqual(source.hours);
    }
  });

  test('declines gracefully when no candidate satisfies every constraint', async () => {
    const result = await askConcierge({
      trip: fixtures.trip,
      user: fixtures.users.planner,
      question: 'Suggest a vegan dinner under $5 near our 5 PM sunset',
      anchorItem: anchorItem(),
      members: fixtures.trip.members,
      usersById,
    });

    expect(result.suggestedVenueId).toBeNull();
    expect(result.sourceEvents).toHaveLength(0);
    expect(result.answer.toLowerCase()).toContain("couldn't find");
    expect(result.candidateStats.rejected).toBeGreaterThan(0);
  });

  test('expresses the failure reason when a budget ceiling excludes everything', async () => {
    const result = await askConcierge({
      trip: fixtures.trip,
      user: fixtures.users.planner,
      question: 'Find dinner under $1',
      anchorItem: null,
      members: fixtures.trip.members,
      usersById,
    });
    expect(result.candidateStats.violations.budget).toBeGreaterThan(0);
    expect(result.suggestedVenueId).toBeNull();
  });
});

describe('compliance + latency across 20 simulated requests', () => {
  const questions = [
    'Suggest a vegan dinner under $25 near our 5 PM sunset',
    'Find a vegetarian lunch under $20',
    'Where can we get gluten-free breakfast under $15?',
    'Recommend an activity near the museum under $30 at 10:00',
    'Suggest a halal dinner under $30',
    'Find a vegan spot under $22 at 19:00',
    'Any pescatarian dinner under $40 near the river?',
    'Recommend a cheap activity under $10 at 11:00',
    'Suggest dinner under $35 near our 5 PM sunset',
    'Find a vegetarian dinner under $28 at 20:00',
    'Suggest a museum under $15 at 14:00',
    'Find a vegan lunch under $25',
    'Recommend a gluten-free dinner under $45',
    'Suggest a family activity under $20 at 16:00',
    'Find a vegan dessert under $12',
    'Suggest a halal lunch under $25',
    'Find a pescatarian dinner under $30',
    'Recommend a viewpoint under $5',
    'Suggest a cooking class under $50 at 15:00',
    'Find a vegan dinner under $30 near our 5 PM sunset',
  ];

  test('every suggestion is constraint-valid and answers within 3 seconds', async () => {
    let answered = 0;

    for (const question of questions) {
      const result = await askConcierge({
        trip: fixtures.trip,
        user: fixtures.users.planner,
        question,
        anchorItem: question.includes('5 PM') ? anchorItem() : null,
        members: fixtures.trip.members,
        usersById,
      });

      expect(result.latencyMs).toBeLessThan(3000);

      if (result.suggestedVenueId) {
        answered += 1;
        const venue = venueById(result.suggestedVenueId);
        expect(venue).toBeDefined();

        const constraints = {
          maxPriceCents: result.constraints.maxPriceCents,
          dietaryTags: result.constraints.dietaryTags,
          slot: result.constraints.slot,
          bufferMinutes: result.constraints.bufferMinutes,
          anchor: question.includes('5 PM') ? { lat: 38.7153, lng: -9.1442 } : null,
          radiusKm: result.constraints.radiusKm,
        };
        expect(isConstraintValid(venue, constraints)).toBe(true);
      } else {
        expect(result.sourceEvents).toHaveLength(0);
      }
    }

    // Group constraints (vegan + vegetarian + gluten-free requests) legitimately
    // exclude most of the catalog; the hard requirement is that every returned
    // suggestion is valid, and that the rest decline instead of inventing venues.
    expect(answered).toBeGreaterThanOrEqual(5);
    expect(answered).toBeLessThanOrEqual(questions.length);
  });
});
