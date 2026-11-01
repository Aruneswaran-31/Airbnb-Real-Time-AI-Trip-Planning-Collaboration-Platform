'use strict';

/**
 * Authoritative itinerary board state machine.
 *
 * Lifecycle: drafting -> voting -> locked
 *   drafting : freely movable / removable by planners
 *   voting   : frozen while a contested-slot vote is live
 *   locked   : immutable, except a Leader/Admin override
 *
 * Concurrency: every accepted mutation bumps `positionVersion`. Clients send the
 * version they last saw; a stale version is rejected with the current state so
 * the losing client can reconcile instead of silently overwriting a peer.
 */

const { ApiError } = require('../middleware/errors');
const { parseTime, tripDayCount } = require('../utils/time');
const { rank } = require('../middleware/auth');

const TRANSITIONS = {
  drafting: ['voting', 'locked'],
  voting: ['locked', 'drafting'],
  locked: ['drafting'],
};

function canTransition(from, to, role = 'planner') {
  if (from === to) return true;
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) return false;
  if (from === 'locked' && to === 'drafting') return rank(role) >= rank('leader');
  return true;
}

/** Validate a board slot against trip bounds. Returns normalised slot or throws. */
function validateSlot({ dayIndex, startTime, endTime }, trip) {
  const day = Number(dayIndex);
  if (!Number.isInteger(day) || day < 0) {
    throw ApiError.badRequest('invalid_day', 'dayIndex must be a non-negative integer');
  }
  const days = tripDayCount(trip.startDate, trip.endDate);
  if (days > 0 && day >= days) {
    throw ApiError.badRequest('invalid_day', `dayIndex ${day} is outside the trip (${days} day(s))`);
  }
  const start = parseTime(startTime);
  const end = parseTime(endTime);
  if (start === null) throw ApiError.badRequest('invalid_time', 'startTime must be HH:MM (24h)');
  if (end === null) throw ApiError.badRequest('invalid_time', 'endTime must be HH:MM (24h)');
  if (end <= start) throw ApiError.badRequest('invalid_time', 'endTime must be after startTime');
  return { dayIndex: day, startTime, endTime };
}

/**
 * Decide whether an actor may mutate an item. Pure: returns a decision object
 * instead of throwing so tests can assert on the reason.
 */
function canMutate({ item, trip, role, action = 'move' }) {
  if (!role) return { allowed: false, reason: 'not_a_member' };
  if (rank(role) < rank('planner')) {
    return { allowed: false, reason: 'read_only', message: 'Viewers can watch the board but not change it' };
  }
  if (trip.roomLocked && rank(role) < rank('leader')) {
    return { allowed: false, reason: 'room_locked', message: 'The Leader has locked this room' };
  }
  if (item.lifecycleStage === 'locked') {
    if (rank(role) < rank('leader')) {
      return { allowed: false, reason: 'item_locked', message: 'This item is locked; ask the Leader to unlock it' };
    }
  }
  if (item.lifecycleStage === 'voting' && rank(role) < rank('leader')) {
    return { allowed: false, reason: 'item_in_vote', message: 'This item is frozen while its slot vote is open' };
  }
  if (action === 'remove' && item.lifecycleStage === 'locked' && rank(role) < rank('leader')) {
    return { allowed: false, reason: 'item_locked', message: 'Locked items cannot be removed' };
  }
  return { allowed: true };
}

/**
 * Apply a move. `expectedVersion` is compared against the stored version.
 * Returns { item, conflict } where conflict is non-null for stale writes.
 */
function applyMove({ item, trip, role, dayIndex, startTime, endTime, expectedVersion }) {
  const decision = canMutate({ item, trip, role, action: 'move' });
  if (!decision.allowed) {
    throw ApiError.forbidden(decision.reason, decision.message || 'You cannot move this item');
  }

  if (expectedVersion === undefined || expectedVersion === null) {
    throw ApiError.badRequest('version_required', 'expectedVersion is required to move an item');
  }
  if (Number(expectedVersion) !== Number(item.positionVersion)) {
    return { item, conflict: { reason: 'stale_version', expectedVersion: Number(expectedVersion), currentVersion: item.positionVersion } };
  }

  const slot = validateSlot({ dayIndex, startTime, endTime }, trip);
  item.dayIndex = slot.dayIndex;
  item.startTime = slot.startTime;
  item.endTime = slot.endTime;
  item.positionVersion += 1;
  return { item, conflict: null };
}

function applyStageChange({ item, nextStage, role }) {
  if (!canTransition(item.lifecycleStage, nextStage, role)) {
    throw ApiError.conflict(
      'invalid_transition',
      `Cannot move an item from ${item.lifecycleStage} to ${nextStage}`,
      { from: item.lifecycleStage, to: nextStage, role }
    );
  }
  item.lifecycleStage = nextStage;
  item.positionVersion += 1;
  if (nextStage === 'locked') item.lockedAt = new Date();
  if (nextStage === 'drafting') item.lockedAt = null;
  return item;
}

module.exports = { canTransition, canMutate, validateSlot, applyMove, applyStageChange, TRANSITIONS };
