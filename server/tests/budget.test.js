'use strict';

const { splitEven, splitWeighted, allocate, computeBudget, replaySpendFromEvents } = require('../src/services/budget');

const trip = {
  totalBudgetCents: 120000,
  currency: 'USD',
  budgetMode: 'even',
};

function members(count, overrides = {}) {
  return Array.from({ length: count }, (_, i) => ({
    userId: `u_${i + 1}`,
    name: `Traveler ${i + 1}`,
    role: 'planner',
    weight: 1,
    ...(overrides[i] || {}),
  }));
}

function item(id, priceCents, category = 'food') {
  return { itemId: id, title: `Item ${id}`, category, pricePerPersonCents: priceCents, lifecycleStage: 'drafting' };
}

describe('exact split arithmetic', () => {
  test('even split of an indivisible total still sums to the total', () => {
    const parts = splitEven(10000, 3);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  test('remainder distribution is deterministic across many totals', () => {
    for (let total = 1; total <= 500; total += 1) {
      for (let people = 1; people <= 7; people += 1) {
        const parts = splitEven(total, people);
        expect(parts).toHaveLength(people);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  test('weighted split respects weights and stays exact', () => {
    const parts = splitWeighted(10000, [1, 1.5, 2.5]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
    // Bigger weight must never receive less than a smaller one.
    expect(parts[2]).toBeGreaterThan(parts[1]);
    expect(parts[1]).toBeGreaterThan(parts[0]);
  });

  test('zero weights degrade to an even split instead of dividing by zero', () => {
    const parts = allocate(1000, [0, 0, 0]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

describe('computeBudget', () => {
  test('computes per-person subtotal, group total and remaining budget', () => {
    const result = computeBudget({
      trip,
      members: members(3),
      items: [item('a', 2200), item('b', 1800, 'activity'), item('c', 10000, 'lodging')],
    });

    expect(result.perPersonSubtotalCents).toBe(14000);
    expect(result.groupTotalCents).toBe(42000);
    expect(result.remainingCents).toBe(78000);
    expect(result.isOverBudget).toBe(false);
    expect(result.utilizationPct).toBe(35);
    expect(result.categories.lodging.groupCents).toBe(30000);
  });

  test('per-person shares always reconcile to the group total', () => {
    const result = computeBudget({
      trip: { ...trip, totalBudgetCents: 99999 },
      members: members(3),
      items: [item('a', 3333), item('b', 3334), item('c', 3334)],
    });
    expect(result.sharesSumCents).toBe(result.groupTotalCents);
  });

  test('weighted mode allocates by member weight exactly', () => {
    const result = computeBudget({
      trip: { ...trip, budgetMode: 'weighted' },
      members: members(3, { 1: { weight: 2 }, 2: { weight: 3 } }),
      items: [item('a', 10000)],
    });
    expect(result.sharesSumCents).toBe(result.groupTotalCents);
    expect(result.members[2].shareCents).toBeGreaterThan(result.members[0].shareCents);
  });

  test('flags a budget breach and per-traveler ceiling breaches', () => {
    const result = computeBudget({
      trip: { ...trip, totalBudgetCents: 10000 },
      members: members(2, { 1: { ceilings: { overallCents: 5000, categories: { food: 1000 } } } }),
      items: [item('a', 9000)],
    });
    expect(result.isOverBudget).toBe(true);
    expect(result.remainingCents).toBeLessThan(0);
    expect(result.members[1].overCeiling).toBe(true);
    expect(result.members[1].categoryBreaches[0].category).toBe('food');
  });

  test('empty board produces a zero-spend picture', () => {
    const result = computeBudget({ trip, members: members(2), items: [] });
    expect(result.groupTotalCents).toBe(0);
    expect(result.remainingCents).toBe(120000);
    expect(result.members.every((m) => m.shareCents === 0)).toBe(true);
  });
});

describe('event-log reconciliation', () => {
  test('replayed spend from the event log matches the live board subtotal', () => {
    const items = [item('a', 2200), item('b', 3400)];
    const events = [
      { type: 'item.pinned', itemId: 'a', pricePerPersonCents: 2200, ts: new Date(1) },
      { type: 'item.pinned', itemId: 'b', pricePerPersonCents: 3400, ts: new Date(2) },
      { type: 'item.removed', itemId: 'a', ts: new Date(3) },
      { type: 'item.pinned', itemId: 'a', pricePerPersonCents: 2200, ts: new Date(4) },
    ];

    const replay = replaySpendFromEvents(events, { travelers: 3 });
    const live = computeBudget({ trip, members: members(3), items });

    expect(replay.perPersonSubtotalCents).toBe(live.perPersonSubtotalCents);
    expect(replay.groupTotalCents).toBe(live.groupTotalCents);
  });
});
