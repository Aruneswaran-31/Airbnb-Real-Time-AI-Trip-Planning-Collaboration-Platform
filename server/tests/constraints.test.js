'use strict';

const { filterVenues, rankCandidates, isConstraintValid, scoreCandidate } = require('../src/services/constraints');
const { loadLisbonVenues } = require('./helpers');

const venues = loadLisbonVenues();

function byId(id) {
  return venues.find((v) => v.venueId === id);
}

describe('hard constraint rules', () => {
  test('budget ceiling rejects venues above the ceiling', () => {
    const result = filterVenues(venues, { maxPriceCents: 2500, dietaryTags: [] });
    expect(result.valid.every((v) => v.pricePerPersonCents <= 2500)).toBe(true);
    expect(result.rejected.some((r) => r.reasons.includes('budget'))).toBe(true);
    expect(result.rejected.find((r) => r.venueId === 'v_3398').detail.budget.overByCents).toBe(9500 - 2500);
  });

  test('dietary compatibility requires every group tag', () => {
    const result = filterVenues(venues, { dietaryTags: ['vegan', 'gluten-free'] });
    expect(result.valid.length).toBeGreaterThan(0);
    for (const venue of result.valid) {
      expect(venue.dietaryTags).toEqual(expect.arrayContaining(['vegan', 'gluten-free']));
    }
    const rejected = result.rejected.find((r) => r.reasons.includes('dietary'));
    expect(rejected.detail.dietary.missingTags.length).toBeGreaterThan(0);
  });

  test('operating hours must contain the slot plus the travel buffer', () => {
    // Taberna da Rua closes at 22:00; 21:15-22:00 + 30m buffer does not fit.
    const withBuffer = filterVenues([byId('v_3391')], {
      slot: { startTime: '21:15', endTime: '22:00' },
      bufferMinutes: 30,
    });
    expect(withBuffer.valid).toHaveLength(0);
    expect(withBuffer.rejected[0].reasons).toContain('hours');

    // Earlier slot fits comfortably.
    const earlier = filterVenues([byId('v_3391')], {
      slot: { startTime: '18:00', endTime: '19:30' },
      bufferMinutes: 30,
    });
    expect(earlier.valid).toHaveLength(1);
  });

  test('closed weekdays are excluded', () => {
    // Museu do Azulejo is closed on Mondays (1).
    const closed = filterVenues([byId('v_3410')], {
      slot: { startTime: '11:00', endTime: '12:00' },
      dayOfWeek: 1,
    });
    expect(closed.valid).toHaveLength(0);

    const open = filterVenues([byId('v_3410')], {
      slot: { startTime: '11:00', endTime: '12:00' },
      dayOfWeek: 2,
    });
    expect(open.valid).toHaveLength(1);
  });

  test('proximity radius filters on real distance', () => {
    const anchor = { lat: 38.7139, lng: -9.1394 }; // Chiado
    const near = filterVenues(venues, { anchor, radiusKm: 1 });
    expect(near.valid.length).toBeGreaterThan(0);
    expect(near.valid.every((v) => v.distanceKm <= 1)).toBe(true);

    // Sintra is ~28km away and must never pass a 2km radius.
    expect(near.valid.find((v) => v.venueId === 'v_3415')).toBeUndefined();
    const sintraRejected = near.rejected.find((r) => r.venueId === 'v_3415');
    expect(sintraRejected.reasons).toContain('proximity');
  });

  test('already-pinned venues can be excluded', () => {
    const result = filterVenues(venues, { excludeVenueIds: ['v_3391'] });
    expect(result.valid.find((v) => v.venueId === 'v_3391')).toBeUndefined();
    expect(result.rejected.find((r) => r.venueId === 'v_3391').reasons).toContain('already_pinned');
  });
});

describe('weighted ranking (40% proximity / 30% rating / 30% budget headroom)', () => {
  test('score breakdown matches the configured weights', () => {
    const venue = filterVenues([byId('v_3391')], { anchor: { lat: 38.7139, lng: -9.1394 }, radiusKm: 2 }).valid[0];
    const scored = scoreCandidate(venue, { anchor: { lat: 38.7139, lng: -9.1394 }, maxPriceCents: 5000, radiusKm: 2 });
    const expected =
      0.4 * scored.breakdown.proximity + 0.3 * scored.breakdown.rating + 0.3 * scored.breakdown.budgetHeadroom;
    expect(scored.score).toBeCloseTo(expected, 2);
  });

  test('closer, cheaper, better-rated venues rank above weaker ones', () => {
    const candidates = filterVenues(venues, {
      anchor: { lat: 38.7107, lng: -9.1365 },
      radiusKm: 2,
      maxPriceCents: 3000,
    }).valid;
    const ranked = rankCandidates(candidates, {
      anchor: { lat: 38.7107, lng: -9.1365 },
      maxPriceCents: 3000,
      radiusKm: 2,
    });
    expect(ranked.length).toBeGreaterThan(1);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });
});

describe('constraint compliance across 20 simulated requests', () => {
  const scenarios = Array.from({ length: 20 }, (_, index) => {
    const budgets = [1500, 2000, 2500, 3000, 4000, 5000];
    const diets = [[], ['vegetarian'], ['vegan'], ['vegetarian', 'gluten-free'], ['halal'], ['pescatarian', 'gluten-free']];
    const slots = [
      { startTime: '12:00', endTime: '13:30' },
      { startTime: '18:00', endTime: '19:30' },
      { startTime: '09:00', endTime: '10:30' },
      { startTime: '20:00', endTime: '21:00' },
    ];
    const anchors = [
      { lat: 38.7139, lng: -9.1394 },
      { lat: 38.7107, lng: -9.1365 },
      { lat: 38.6973, lng: -9.2032 },
      { lat: 38.7167, lng: -9.1444 },
    ];
    return {
      maxPriceCents: budgets[index % budgets.length],
      dietaryTags: diets[index % diets.length],
      slot: slots[index % slots.length],
      anchor: anchors[index % anchors.length],
      radiusKm: [0.8, 1.5, 2, 3][index % 4],
      bufferMinutes: 30,
    };
  });

  test('every returned candidate satisfies all active constraints', () => {
    let suggestedCount = 0;

    for (const constraints of scenarios) {
      const filtered = filterVenues(venues, constraints);
      for (const candidate of filtered.valid) {
        expect(isConstraintValid(candidate, constraints)).toBe(true);
        expect(candidate.pricePerPersonCents).toBeLessThanOrEqual(constraints.maxPriceCents);
        expect(candidate.dietaryTags).toEqual(expect.arrayContaining(constraints.dietaryTags));
        expect(candidate.distanceKm).toBeLessThanOrEqual(constraints.radiusKm);
      }

      const ranked = rankCandidates(filtered.valid, constraints);
      if (ranked.length > 0) {
        suggestedCount += 1;
        const top = ranked[0].venue;
        expect(isConstraintValid(top, constraints)).toBe(true);
      }
    }

    expect(suggestedCount).toBeGreaterThan(0);
  });
});
