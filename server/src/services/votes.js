'use strict';

/**
 * Contested-slot voting engine.
 *
 * A vote freezes its candidate items (lifecycleStage -> voting) so nobody can
 * move a candidate mid-vote, tallies ballots, applies the winner to the slot and
 * clears losing items off the board.
 */

const Vote = require('../models/Vote');
const ItineraryItem = require('../models/ItineraryItem');
const { ApiError } = require('../middleware/errors');

const DEFAULT_DURATION_SECONDS = 120;

function tally(vote) {
  const counts = new Map(vote.candidateItemIds.map((id) => [String(id), 0]));
  for (const ballot of vote.ballots) {
    const key = String(ballot.candidateItemId);
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const topVotes = ranked.length ? ranked[0][1] : 0;
  const tied = ranked.filter(([, count]) => count === topVotes).map(([id]) => id);
  return { counts, ranked, topVotes, tied };
}

/**
 * Winner selection is deterministic:
 *   1. most votes
 *   2. tie -> lowest price per person (cheaper shared choice)
 *   3. still tied -> earliest created item
 */
async function chooseWinner(vote) {
  const { tied, topVotes } = tally(vote);
  if (tied.length === 0) return { winnerId: null, resolution: 'expired', voteCount: 0 };
  if (tied.length === 1) return { winnerId: tied[0], resolution: 'tallied', voteCount: topVotes };

  const items = await ItineraryItem.find({ _id: { $in: tied } }).sort({ createdAt: 1 });
  const sorted = [...items].sort(
    (a, b) => (a.pricePerPersonCents || 0) - (b.pricePerPersonCents || 0) || new Date(a.createdAt) - new Date(b.createdAt)
  );
  return { winnerId: String(sorted[0]._id), resolution: 'tie-break', voteCount: topVotes };
}

async function openVote({ trip, actorId, candidateItemIds, closesInSeconds = DEFAULT_DURATION_SECONDS }) {
  if (!Array.isArray(candidateItemIds) || candidateItemIds.length < 2) {
    throw ApiError.badRequest('insufficient_candidates', 'A contested-slot vote needs at least two candidate items');
  }

  const items = await ItineraryItem.find({ _id: { $in: candidateItemIds }, tripId: trip._id });
  if (items.length !== new Set(candidateItemIds.map(String)).size) {
    throw ApiError.badRequest('invalid_candidates', 'Every candidate must be an item in this trip');
  }

  const first = items[0];
  if (items.some((item) => item.dayIndex !== first.dayIndex || item.startTime !== first.startTime)) {
    throw ApiError.badRequest('candidates_not_same_slot', 'Candidates must share the same day and start time');
  }
  if (items.some((item) => item.lifecycleStage === 'locked')) {
    throw ApiError.conflict('item_locked', 'Locked items cannot enter a vote');
  }

  const existing = await Vote.findOne({
    tripId: trip._id,
    status: 'open',
    'slot.dayIndex': first.dayIndex,
    'slot.startTime': first.startTime,
  });
  if (existing) {
    throw ApiError.conflict('vote_already_open', 'This slot already has an open vote', { voteId: String(existing._id) });
  }

  const closesAt = new Date(Date.now() + Math.min(Math.max(closesInSeconds, 15), 900) * 1000);
  const vote = await Vote.create({
    tripId: trip._id,
    slot: { dayIndex: first.dayIndex, startTime: first.startTime, endTime: first.endTime },
    candidateItemIds: items.map((item) => item._id),
    openedByUserId: actorId,
    closesAt,
  });

  await ItineraryItem.updateMany(
    { _id: { $in: items.map((i) => i._id) } },
    { $set: { lifecycleStage: 'voting' }, $inc: { positionVersion: 1 } }
  );

  return Vote.findById(vote._id);
}

async function castBallot({ vote, itemId, userId }) {
  if (vote.status !== 'open') throw ApiError.conflict('vote_closed', 'This vote is not open');
  if (new Date(vote.closesAt).getTime() < Date.now()) {
    throw ApiError.conflict('vote_expired', 'This vote has closed');
  }
  if (!vote.candidateItemIds.map(String).includes(String(itemId))) {
    throw ApiError.badRequest('invalid_candidate', 'That item is not a candidate in this vote');
  }

  const existingIndex = vote.ballots.findIndex((b) => String(b.userId) === String(userId));
  if (existingIndex >= 0) {
    vote.ballots[existingIndex].candidateItemId = itemId;
    vote.ballots[existingIndex].castAt = new Date();
  } else {
    vote.ballots.push({ userId, candidateItemId: itemId, castAt: new Date() });
  }
  await vote.save();
  return vote;
}

/**
 * Resolve a vote: winner keeps the slot, losers leave the board.
 * Returns { vote, winner, losers }.
 */
async function resolveVote({ vote, resolutionOverride }) {
  if (vote.status !== 'open') return { vote, winner: null, losers: [] };

  const { winnerId, resolution, voteCount } = await chooseWinner(vote);
  const loserIds = vote.candidateItemIds.map(String).filter((id) => id !== String(winnerId));

  if (winnerId) {
    await ItineraryItem.updateOne(
      { _id: winnerId },
      { $set: { lifecycleStage: 'drafting' }, $inc: { positionVersion: 1 } }
    );
    if (loserIds.length) {
      await ItineraryItem.deleteMany({ _id: { $in: loserIds } });
    }
  } else {
    await ItineraryItem.updateMany(
      { _id: { $in: vote.candidateItemIds } },
      { $set: { lifecycleStage: 'drafting' }, $inc: { positionVersion: 1 } }
    );
  }

  vote.status = 'resolved';
  vote.winningItemId = winnerId || null;
  vote.resolvedAt = new Date();
  vote.resolution = resolutionOverride || resolution;
  await vote.save();

  const winner = winnerId ? await ItineraryItem.findById(winnerId) : null;
  return { vote, winner, losers: loserIds, voteCount };
}

async function resolveExpiredVotes({ tripId } = {}) {
  const query = { status: 'open', closesAt: { $lte: new Date() } };
  if (tripId) query.tripId = tripId;
  const expired = await Vote.find(query);
  const resolved = [];
  for (const vote of expired) {
    resolved.push(await resolveVote({ vote, resolutionOverride: 'expired' }));
  }
  return resolved;
}

module.exports = { openVote, castBallot, resolveVote, resolveExpiredVotes, tally, chooseWinner, DEFAULT_DURATION_SECONDS };
