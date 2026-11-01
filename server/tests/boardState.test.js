'use strict';

const { canTransition, canMutate, validateSlot, applyMove, applyStageChange } = require('../src/services/boardState');

const trip = {
  startDate: '2026-11-10',
  endDate: '2026-11-13',
  roomLocked: false,
  status: 'drafting',
};

function makeItem(overrides = {}) {
  return {
    title: 'Item',
    dayIndex: 1,
    startTime: '10:00',
    endTime: '11:00',
    lifecycleStage: 'drafting',
    positionVersion: 3,
    ...overrides,
  };
}

describe('lifecycle transitions', () => {
  test('drafting can move to voting or locked', () => {
    expect(canTransition('drafting', 'voting')).toBe(true);
    expect(canTransition('drafting', 'locked')).toBe(true);
  });

  test('locked only returns to drafting with leader authority', () => {
    expect(canTransition('locked', 'drafting', 'planner')).toBe(false);
    expect(canTransition('locked', 'drafting', 'leader')).toBe(true);
    expect(canTransition('locked', 'voting', 'leader')).toBe(false);
  });

  test('applyStageChange rejects an illegal transition', () => {
    const item = makeItem({ lifecycleStage: 'locked' });
    expect(() => applyStageChange({ item, nextStage: 'voting', role: 'leader' })).toThrow(/Cannot move an item/);
  });

  test('applyStageChange bumps the position version', () => {
    const item = makeItem();
    applyStageChange({ item, nextStage: 'locked', role: 'leader' });
    expect(item.lifecycleStage).toBe('locked');
    expect(item.positionVersion).toBe(4);
    expect(item.lockedAt).toBeInstanceOf(Date);
  });
});

describe('mutation permissions', () => {
  test('viewers are read-only', () => {
    const decision = canMutate({ item: makeItem(), trip, role: 'viewer' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('read_only');
  });

  test('a locked room blocks planners but not the leader', () => {
    const lockedTrip = { ...trip, roomLocked: true };
    expect(canMutate({ item: makeItem(), trip: lockedTrip, role: 'planner' }).reason).toBe('room_locked');
    expect(canMutate({ item: makeItem(), trip: lockedTrip, role: 'leader' }).allowed).toBe(true);
  });

  test('locked items reject planners and accept leader overrides', () => {
    const item = makeItem({ lifecycleStage: 'locked' });
    expect(canMutate({ item, trip, role: 'planner', action: 'remove' }).reason).toBe('item_locked');
    expect(canMutate({ item, trip, role: 'leader', action: 'remove' }).allowed).toBe(true);
  });

  test('items frozen in a live vote cannot be moved by planners', () => {
    const item = makeItem({ lifecycleStage: 'voting' });
    expect(canMutate({ item, trip, role: 'planner' }).reason).toBe('item_in_vote');
    expect(canMutate({ item, trip, role: 'leader' }).allowed).toBe(true);
  });
});

describe('slot validation', () => {
  test('rejects days outside the trip', () => {
    expect(() => validateSlot({ dayIndex: 9, startTime: '10:00', endTime: '11:00' }, trip)).toThrow(/outside the trip/);
  });

  test('rejects an end time before the start', () => {
    expect(() => validateSlot({ dayIndex: 0, startTime: '11:00', endTime: '10:00' }, trip)).toThrow(/after startTime/);
  });

  test('rejects malformed times', () => {
    expect(() => validateSlot({ dayIndex: 0, startTime: '25:00', endTime: '26:00' }, trip)).toThrow(/HH:MM/);
  });
});

describe('optimistic concurrency', () => {
  test('a move with the current version is accepted and bumps the version', () => {
    const item = makeItem();
    const result = applyMove({
      item,
      trip,
      role: 'planner',
      dayIndex: 2,
      startTime: '14:00',
      endTime: '15:30',
      expectedVersion: 3,
    });
    expect(result.conflict).toBeNull();
    expect(item.dayIndex).toBe(2);
    expect(item.positionVersion).toBe(4);
  });

  test('a stale move is refused with the current state, not silently applied', () => {
    const item = makeItem();
    const first = applyMove({ item, trip, role: 'planner', dayIndex: 2, startTime: '14:00', endTime: '15:00', expectedVersion: 3 });
    expect(first.conflict).toBeNull();

    const second = applyMove({ item, trip, role: 'planner', dayIndex: 2, startTime: '16:00', endTime: '17:00', expectedVersion: 3 });
    expect(second.conflict).not.toBeNull();
    expect(second.conflict.reason).toBe('stale_version');
    expect(second.conflict.currentVersion).toBe(4);
    // The board keeps the first planner's position.
    expect(item.startTime).toBe('14:00');
  });

  test('expectedVersion is mandatory', () => {
    expect(() =>
      applyMove({ item: makeItem(), trip, role: 'planner', dayIndex: 1, startTime: '12:00', endTime: '13:00' })
    ).toThrow(/expectedVersion is required/);
  });

  test('a viewer move is refused even with the correct version', () => {
    expect(() =>
      applyMove({ item: makeItem(), trip, role: 'viewer', dayIndex: 1, startTime: '12:00', endTime: '13:00', expectedVersion: 3 })
    ).toThrow(/Viewers/);
  });
});
