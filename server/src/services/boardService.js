'use strict';

/**
 * Board application service.
 *
 * Single source of truth for itinerary mutations. Both the REST API and the
 * Socket.io gateway call these functions, so the lifecycle rules, optimistic
 * concurrency, event log, conflict detection and budget recomputation behave
 * identically no matter which entry point a planner used.
 */

const ItineraryItem = require('../models/ItineraryItem');
const Vote = require('../models/Vote');
const ChatMessage = require('../models/ChatMessage');
const Interaction = require('../models/Interaction');
const Event = require('../models/Event');
const User = require('../models/User');
const Venue = require('../models/Venue');

const { ApiError } = require('../middleware/errors');
const boardState = require('./boardState');
const { computeBudget } = require('./budget');
const { detectConflicts, diffConflicts } = require('./conflicts');
const hub = require('../realtime/hub');
const { sanitizeText } = require('../utils/sanitize');
const { rank } = require('../middleware/auth');

const MAX_ITEMS_PER_DAY = 24;

async function logEvent(tripId, type, { userId = null, itemId = null, venueId = null, pricePerPersonCents = null, dayIndex = null, payload = {} } = {}) {
  try {
    await Event.create({ tripId, type, userId, itemId, venueId, pricePerPersonCents, dayIndex, payload });
  } catch {
    /* event log must never break a board mutation */
  }
}

async function loadMembers(trip) {
  const users = await User.find({ _id: { $in: trip.members.map((m) => m.userId) } });
  const usersById = Object.fromEntries(users.map((u) => [String(u._id), u.toObject()]));
  return { usersById, users };
}

function memberRows(trip, usersById) {
  return trip.members.map((m) => {
    const user = usersById[String(m.userId)] || {};
    return {
      userId: String(m.userId),
      name: user.displayName || 'Traveler',
      email: user.email,
      role: String(m.userId) === String(trip.leaderUserId) ? 'leader' : m.role,
      weight: m.weight,
      muted: m.muted,
      joinedAt: m.joinedAt,
      dietaryTags: user.dietaryTags || [],
      maxPerPersonBudgetCents: user.preferences?.maxPerPersonBudgetCents ?? null,
      ceilings: {
        overallCents: user.preferences?.maxPerPersonBudgetCents,
        categories: user.preferences?.categoryCeilings,
      },
    };
  });
}

/** Compute the live budget for the current board. */
async function budgetFor(trip, items, members) {
  return computeBudget({
    trip,
    members: members.map((m) => ({
      userId: m.userId,
      name: m.name,
      role: m.role,
      weight: m.weight,
      ceilings: m.ceilings,
    })),
    items: items.map((item) => ({ ...item, itemId: String(item._id || item.itemId) })),
  });
}

async function activeItems(trip) {
  return ItineraryItem.find({ tripId: trip._id }).sort({ dayIndex: 1, startTime: 1, createdAt: 1 }).lean();
}

async function openVotes(trip) {
  return Vote.find({ tripId: trip._id, status: 'open' }).lean();
}

/** Full resync payload: what a joining client needs to render the room. */
async function boardSnapshot(trip, { role = null } = {}) {
  const items = await activeItems(trip);
  const { usersById } = await loadMembers(trip);
  const members = memberRows(trip, usersById);
  const budget = await budgetFor(trip, items, members);
  const conflicts = detectConflicts({
    trip,
    items,
    members: trip.members,
    usersById,
  });
  const votes = await openVotes(trip);

  return {
    trip: {
      ...trip.toPublicJSON(),
      tripId: String(trip._id),
    },
    role,
    members,
    items: items.map((item) => ({ ...item, itemId: String(item._id), _id: undefined })),
    budget,
    conflicts: conflicts.map((c) => ({ ...c, conflictKey: c.conflictKey })),
    votes: votes.map((v) => ({ ...v, voteId: String(v._id), _id: undefined })),
    presence: hub.presenceList(trip._id),
    leaderState: hub.getLeaderState(trip._id),
    serverTime: new Date().toISOString(),
  };
}

/**
 * Recompute budget + conflicts after any mutation, broadcast the new board and
 * emit raised/resolved conflict events. Also keeps the analytics event log honest.
 */
async function afterMutation({ trip, actorId = null, changedItemId = null, extra = {} }) {
  // Fetch board + member metadata in parallel: this path is on the hot path of
  // every board mutation, so it stays close to two round trips.
  const [items, memberData] = await Promise.all([activeItems(trip), loadMembers(trip)]);
  const { usersById } = memberData;
  const members = memberRows(trip, usersById);
  const budget = await budgetFor(trip, items, members);
  const conflicts = detectConflicts({ trip, items, members: trip.members, usersById });

  const previous = hub.getConflictKeys(trip._id);
  const { raised, resolved, next } = diffConflicts(previous, conflicts);
  hub.setConflictKeys(trip._id, next);

  const payload = {
    items: items.map((item) => ({ ...item, itemId: String(item._id), _id: undefined })),
    budget,
    conflicts: conflicts.map((c) => ({ ...c, conflictKey: c.conflictKey })),
    changedItemId,
    ...extra,
  };

  // Broadcast the board first, then flag conflicts, then persist analytics events.
  // Clients see the mutation immediately; logging never delays the fan-out.
  hub.emitToTrip(trip._id, 'trip.board.update', payload);

  for (const conflict of raised) {
    hub.emitToTrip(trip._id, 'trip.board.conflict', { status: 'raised', ...conflict });
  }
  for (const key of resolved) {
    hub.emitToTrip(trip._id, 'trip.board.conflict', { status: 'resolved', conflictKey: key });
  }

  await Promise.all([
    ...raised.map((conflict) =>
      logEvent(trip._id, 'conflict.flagged', {
        userId: actorId,
        payload: { conflictType: conflict.conflictType, conflictKey: conflict.conflictKey, details: conflict.details },
      })
    ),
    ...resolved.map((key) => logEvent(trip._id, 'conflict.resolved', { userId: actorId, payload: { conflictKey: key } })),
  ]);

  return payload;
}

function assertRoomWritable(trip) {
  if (trip.roomLocked) {
    throw ApiError.forbidden('room_locked', 'The Leader has locked this room');
  }
  if (trip.status === 'completed') {
    throw ApiError.conflict('trip_completed', 'This trip is completed and read-only');
  }
}

function assertSlotWithinDay(trip, items, dayIndex) {
  const count = items.filter((item) => item.dayIndex === dayIndex).length;
  if (count >= MAX_ITEMS_PER_DAY) {
    throw ApiError.badRequest('day_full', `A single day cannot hold more than ${MAX_ITEMS_PER_DAY} items`);
  }
}

async function recordInteraction({ user, trip, venueId, category, event, score = 1, liked = false }) {
  try {
    await Interaction.create({
      userId: user._id,
      tripId: trip._id,
      destinationSlug: trip.destinationSlug,
      venueId,
      category,
      event,
      liked,
      score,
    });
  } catch {
    /* non-critical */
  }
}

/** Pin a venue (or a custom card) to the board. */
async function pinItem({ trip, user, role, input }) {
  assertRoomWritable(trip);
  const decision = boardState.canMutate({ item: { lifecycleStage: 'drafting' }, trip, role, action: 'pin' });
  if (!decision.allowed) {
    throw ApiError.forbidden(decision.reason, decision.message || 'You cannot pin items');
  }

  const slot = boardState.validateSlot(input, trip);
  const existing = await activeItems(trip);
  assertSlotWithinDay(trip, existing, slot.dayIndex);

  let itemData = {
    tripId: trip._id,
    dayIndex: slot.dayIndex,
    startTime: slot.startTime,
    endTime: slot.endTime,
    pinnedByUserId: user._id,
    pinnedByName: user.displayName,
    note: sanitizeText(input.note || '', { maxLength: 500 }),
  };

  if (input.venueId) {
    const venue = await Venue.findOne({ destinationSlug: trip.destinationSlug, venueId: input.venueId }).lean();
    if (!venue) throw ApiError.badRequest('venue_not_found', 'That venue is not in this destination dataset');
    itemData = {
      ...itemData,
      venueId: venue.venueId,
      title: venue.name,
      category: venue.category,
      pricePerPersonCents: venue.pricePerPersonCents,
      dietaryTags: venue.dietaryTags,
      coordinates: venue.coordinates,
      venueSnapshot: {
        name: venue.name,
        category: venue.category,
        pricePerPersonCents: venue.pricePerPersonCents,
        dietaryTags: venue.dietaryTags,
        hours: venue.hours,
        rating: venue.rating,
        description: venue.description,
        transit: venue.transit,
      },
    };
  } else {
    const title = sanitizeText(input.title || '', { maxLength: 120 });
    if (!title) throw ApiError.badRequest('title_required', 'A title is required for a custom card');
    itemData = {
      ...itemData,
      title,
      category: input.category || 'activity',
      pricePerPersonCents: Math.round((Number(input.pricePerPerson) || 0) * 100),
      dietaryTags: input.dietaryTags || [],
      coordinates: input.coordinates || { lat: null, lng: null },
    };
  }

  const item = await ItineraryItem.create(itemData);
  await logEvent(trip._id, 'item.pinned', {
    userId: user._id,
    itemId: item._id,
    venueId: item.venueId,
    pricePerPersonCents: item.pricePerPersonCents,
    dayIndex: item.dayIndex,
  });
  if (item.venueId) {
    await recordInteraction({ user, trip, venueId: item.venueId, category: item.category, event: 'pinned', score: 1.2 });
  }

  const snapshot = await afterMutation({ trip, actorId: user._id, changedItemId: String(item._id) });
  return { item: item.toPublicJSON(), ...snapshot };
}

/**
 * Move an item with optimistic concurrency.
 *
 * The version check and the write are a single atomic conditional update
 * (`positionVersion` in the filter), so two simultaneous moves on the same item
 * can never both succeed — the loser gets the current state back instead of
 * silently overwriting the winner.
 */
async function moveItem({ trip, user, role, itemId, dayIndex, startTime, endTime, expectedVersion, note }) {
  assertRoomWritable(trip);
  const item = await ItineraryItem.findOne({ _id: itemId, tripId: trip._id });
  if (!item) throw ApiError.notFound('item_not_found', 'Itinerary item not found');

  const decision = boardState.canMutate({ item, trip, role, action: 'move' });
  if (!decision.allowed) throw ApiError.forbidden(decision.reason, decision.message || 'You cannot move this item');

  if (expectedVersion === undefined || expectedVersion === null) {
    throw ApiError.badRequest('version_required', 'expectedVersion is required to move an item');
  }

  const slot = boardState.validateSlot({ dayIndex, startTime, endTime }, trip);
  const update = { dayIndex: slot.dayIndex, startTime: slot.startTime, endTime: slot.endTime };
  if (note !== undefined) update.note = sanitizeText(note, { maxLength: 500 });

  const updated = await ItineraryItem.findOneAndUpdate(
    {
      _id: item._id,
      tripId: trip._id,
      positionVersion: Number(expectedVersion),
      lifecycleStage: item.lifecycleStage,
    },
    { $set: update, $inc: { positionVersion: 1 } },
    { new: true }
  );

  if (!updated) {
    const current = await ItineraryItem.findById(item._id);
    const currentItem = current ? current.toPublicJSON() : item.toPublicJSON();
    return {
      conflict: {
        reason: 'stale_version',
        expectedVersion: Number(expectedVersion),
        currentVersion: current ? current.positionVersion : null,
        item: currentItem,
      },
      item: currentItem,
    };
  }

  await logEvent(trip._id, 'item.moved', {
    userId: user._id,
    itemId: updated._id,
    dayIndex: updated.dayIndex,
    payload: { startTime: updated.startTime, endTime: updated.endTime, positionVersion: updated.positionVersion },
  });

  const snapshot = await afterMutation({ trip, actorId: user._id, changedItemId: String(updated._id) });
  return { item: updated.toPublicJSON(), conflict: null, ...snapshot };
}

async function removeItem({ trip, user, role, itemId }) {
  assertRoomWritable(trip);
  const item = await ItineraryItem.findOne({ _id: itemId, tripId: trip._id });
  if (!item) throw ApiError.notFound('item_not_found', 'Itinerary item not found');

  const decision = boardState.canMutate({ item, trip, role, action: 'remove' });
  if (!decision.allowed) throw ApiError.forbidden(decision.reason, decision.message);

  await ItineraryItem.deleteOne({ _id: item._id });
  await logEvent(trip._id, 'item.removed', {
    userId: user._id,
    itemId: item._id,
    venueId: item.venueId,
    pricePerPersonCents: item.pricePerPersonCents,
    dayIndex: item.dayIndex,
  });

  const snapshot = await afterMutation({ trip, actorId: user._id, changedItemId: String(item._id) });
  return { removedItemId: String(item._id), ...snapshot };
}

/** Lock / unlock a finalized item (Leader or Admin only). */
async function setItemLock({ trip, user, role, itemId, locked }) {
  const item = await ItineraryItem.findOne({ _id: itemId, tripId: trip._id });
  if (!item) throw ApiError.notFound('item_not_found', 'Itinerary item not found');

  if (rank(role) < rank('leader')) {
    throw ApiError.forbidden('insufficient_role', 'Only the Trip Leader can lock or unlock itinerary items');
  }

  const leaderState = hub.getLeaderState(trip._id);
  if (locked && leaderState.frozen) {
    throw ApiError.conflict('leader_offline', 'Locks are frozen while no Leader is connected to the room');
  }

  if (locked) {
    if (item.lifecycleStage === 'voting') {
      throw ApiError.conflict('item_in_vote', 'Resolve the open slot vote before locking this item');
    }
    boardState.applyStageChange({ item, nextStage: 'locked', role });
    item.lockedByUserId = user._id;
  } else {
    boardState.applyStageChange({ item, nextStage: 'drafting', role });
    item.lockedByUserId = null;
  }
  await item.save();

  await logEvent(trip._id, locked ? 'item.locked' : 'item.unlocked', { userId: user._id, itemId: item._id });
  const snapshot = await afterMutation({ trip, actorId: user._id, changedItemId: String(item._id) });
  return { item: item.toPublicJSON(), ...snapshot };
}

/** Chat message append + broadcast. */
async function postChatMessage({ trip, user, body, msgType = 'chat' }) {
  const text = sanitizeText(body, { maxLength: 2000 });
  if (!text) throw ApiError.badRequest('empty_message', 'Message cannot be empty');

  if (trip.roomLocked) throw ApiError.forbidden('room_locked', 'The Leader has locked this room');
  const member = trip.memberFor(user._id);
  if (member && member.muted) throw ApiError.forbidden('muted', 'You have been muted by the Trip Leader');

  const message = await ChatMessage.create({
    tripId: trip._id,
    userId: user._id,
    authorName: user.displayName,
    msgType,
    body: text,
  });

  await logEvent(trip._id, 'chat.message', { userId: user._id, payload: { msgType } });

  const payload = {
    message: { ...message.toPublicJSON(), userId: message.userId ? String(message.userId) : null, tripId: String(trip._id) },
  };
  hub.emitToTrip(trip._id, 'trip.chat.message', payload);
  return payload;
}

async function toggleReaction({ trip, user, messageId, emoji }) {
  const cleanEmoji = sanitizeText(emoji, { maxLength: 8 });
  const message = await ChatMessage.findOne({ _id: messageId, tripId: trip._id });
  if (!message) throw ApiError.notFound('message_not_found', 'Message not found');

  const existing = message.reactions.find((r) => r.emoji === cleanEmoji);
  if (existing) {
    const index = existing.userIds.findIndex((id) => String(id) === String(user._id));
    if (index >= 0) existing.userIds.splice(index, 1);
    else existing.userIds.push(user._id);
    if (existing.userIds.length === 0) {
      message.reactions = message.reactions.filter((r) => r.emoji !== cleanEmoji);
    }
  } else {
    message.reactions.push({ emoji: cleanEmoji, userIds: [user._id] });
  }
  await message.save();

  const payload = {
    messageId: String(message._id),
    reactions: message.reactions.map((r) => ({ emoji: r.emoji, userIds: r.userIds.map(String) })),
  };
  hub.emitToTrip(trip._id, 'trip.chat.reaction', payload);
  return payload;
}

module.exports = {
  logEvent,
  loadMembers,
  memberRows,
  budgetFor,
  activeItems,
  openVotes,
  boardSnapshot,
  afterMutation,
  pinItem,
  moveItem,
  removeItem,
  setItemLock,
  postChatMessage,
  toggleReaction,
  recordInteraction,
  assertRoomWritable,
  MAX_ITEMS_PER_DAY,
};
