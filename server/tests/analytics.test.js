'use strict';

const { buildSessionAnalytics } = require('../src/services/analytics');
const { computeBudget } = require('../src/services/budget');
const votes = require('../src/services/votes');
const ItineraryItem = require('../src/models/ItineraryItem');
const Event = require('../src/models/Event');
const { startDb, stopDb, clearDb, seedFixtures } = require('./helpers');

let fixtures;
let usersById;

beforeAll(async () => {
  await startDb();
  fixtures = await seedFixtures();
  usersById = Object.fromEntries(Object.values(fixtures.users).map((u) => [String(u._id), u.toObject()]));
});

afterAll(async () => {
  await clearDb();
  await stopDb();
});

describe('session analytics', () => {
  test('numbers are derived from the event log and reconcile with the live board', async () => {
    const items = await ItineraryItem.find({ tripId: fixtures.trip._id }).lean();
    const events = await Event.find({ tripId: fixtures.trip._id }).lean();

    const analytics = buildSessionAnalytics({
      trip: fixtures.trip,
      items,
      events,
      members: fixtures.trip.members,
      usersById,
    });

    expect(analytics.itemsPinned).toBe(fixtures.items.length);
    expect(analytics.aiQuestionsAsked).toBe(1);
    expect(analytics.peakConcurrentPlanners).toBe(2);
    expect(analytics.reconciliation.matches).toBe(true);
    expect(analytics.reconciliation.deltaCents).toBe(0);
    expect(analytics.finalPerPersonBreakdown).toHaveLength(3);

    const budget = computeBudget({
      trip: fixtures.trip,
      members: fixtures.trip.members.map((m) => {
        const user = usersById[String(m.userId)];
        return {
          userId: String(m.userId),
          name: user.displayName,
          role: m.role,
          weight: m.weight,
          ceilings: { overallCents: user.preferences.maxPerPersonBudgetCents },
        };
      }),
      items,
    });
    expect(analytics.budget.groupTotalCents).toBe(budget.groupTotalCents);
    expect(analytics.finalPerPersonBreakdown.reduce((sum, m) => sum + m.shareCents, 0)).toBe(budget.groupTotalCents);
  });
});

describe('contested-slot voting', () => {
  test('opens, tallies and applies the winner, removing losers from the board', async () => {
    const day = 3;
    const candidates = await ItineraryItem.insertMany([
      {
        tripId: fixtures.trip._id,
        venueId: 'v_3392',
        title: 'Cantinho Verde',
        category: 'food',
        dayIndex: day,
        startTime: '19:00',
        endTime: '20:30',
        pricePerPersonCents: 1800,
        dietaryTags: ['vegan', 'vegetarian'],
        coordinates: { lat: 38.7107, lng: -9.1365 },
        pinnedByUserId: fixtures.users.leader._id,
        pinnedByName: 'Leader',
      },
      {
        tripId: fixtures.trip._id,
        venueId: 'v_3391',
        title: 'Taberna da Rua',
        category: 'food',
        dayIndex: day,
        startTime: '19:00',
        endTime: '20:30',
        pricePerPersonCents: 2200,
        dietaryTags: ['vegetarian'],
        coordinates: { lat: 38.7139, lng: -9.1394 },
        pinnedByUserId: fixtures.users.planner._id,
        pinnedByName: 'Planner',
      },
    ]);

    const vote = await votes.openVote({
      trip: fixtures.trip,
      actorId: fixtures.users.leader._id,
      candidateItemIds: candidates.map((c) => String(c._id)),
      closesInSeconds: 60,
    });

    expect(vote.status).toBe('open');
    const frozen = await ItineraryItem.find({ _id: { $in: candidates.map((c) => c._id) } }).lean();
    expect(frozen.every((item) => item.lifecycleStage === 'voting')).toBe(true);

    // Two ballots for the cheaper option, one for the other.
    let live = vote;
    live = await votes.castBallot({ vote: live, itemId: String(candidates[0]._id), userId: fixtures.users.leader._id });
    live = await votes.castBallot({ vote: live, itemId: String(candidates[0]._id), userId: fixtures.users.planner._id });
    live = await votes.castBallot({ vote: live, itemId: String(candidates[1]._id), userId: fixtures.users.viewer._id });

    const tally = votes.tally(live);
    expect(tally.counts.get(String(candidates[0]._id))).toBe(2);
    expect(tally.counts.get(String(candidates[1]._id))).toBe(1);

    const resolved = await votes.resolveVote({ vote: live });
    expect(resolved.vote.status).toBe('resolved');
    expect(String(resolved.vote.winningItemId)).toBe(String(candidates[0]._id));

    const winnerStillThere = await ItineraryItem.findById(candidates[0]._id);
    const loserGone = await ItineraryItem.findById(candidates[1]._id);
    expect(winnerStillThere).toBeTruthy();
    expect(winnerStillThere.lifecycleStage).toBe('drafting');
    expect(loserGone).toBeNull();
  });

  test('rejects a vote with fewer than two candidates', async () => {
    await expect(
      votes.openVote({ trip: fixtures.trip, actorId: fixtures.users.leader._id, candidateItemIds: [String(fixtures.items[0]._id)] })
    ).rejects.toThrow(/at least two candidate items/);
  });

  test('a vote can only be opened once per slot', async () => {
    const candidates = await ItineraryItem.insertMany([
      {
        tripId: fixtures.trip._id,
        title: 'A',
        category: 'food',
        dayIndex: 4,
        startTime: '12:00',
        endTime: '13:00',
        pricePerPersonCents: 1000,
        pinnedByUserId: fixtures.users.leader._id,
        pinnedByName: 'Leader',
      },
      {
        tripId: fixtures.trip._id,
        title: 'B',
        category: 'food',
        dayIndex: 4,
        startTime: '12:00',
        endTime: '13:00',
        pricePerPersonCents: 2000,
        pinnedByUserId: fixtures.users.leader._id,
        pinnedByName: 'Leader',
      },
    ]);

    await votes.openVote({
      trip: fixtures.trip,
      actorId: fixtures.users.leader._id,
      candidateItemIds: candidates.map((c) => String(c._id)),
    });

    await expect(
      votes.openVote({
        trip: fixtures.trip,
        actorId: fixtures.users.leader._id,
        candidateItemIds: candidates.map((c) => String(c._id)),
      })
    ).rejects.toThrow(/already has an open vote/);
  });
});
