'use strict';

const express = require('express');
const { z } = require('zod');

const Vote = require('../models/Vote');

const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate } = require('../middleware/validate');
const { loadTrip, requireTripRole } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const votes = require('../services/votes');
const boardService = require('../services/boardService');
const hub = require('../realtime/hub');

const router = express.Router({ mergeParams: true });

router.use(loadTrip);

/** Open a timed vote on a contested slot. */
router.post(
  '/',
  writeLimiter,
  requireTripRole('planner'),
  validate({
    body: z.object({
      candidateItemIds: z.array(z.string().min(3)).min(2).max(6),
      closesInSeconds: z.number().int().min(15).max(900).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const vote = await votes.openVote({
      trip: req.trip,
      actorId: req.user._id,
      candidateItemIds: req.body.candidateItemIds,
      closesInSeconds: req.body.closesInSeconds,
    });

    await boardService.logEvent(req.trip._id, 'vote.opened', {
      userId: req.user._id,
      payload: { voteId: String(vote._id), slot: vote.slot, candidateItemIds: vote.candidateItemIds.map(String) },
    });

    const payload = {
      vote: { ...vote.toPublicJSON(), voteId: String(vote._id) },
      itemIds: vote.candidateItemIds.map(String),
    };
    hub.emitToTrip(req.trip._id, 'trip.vote.open', payload);
    const snapshot = await boardService.afterMutation({ trip: req.trip, actorId: req.user._id });
    res.status(201).json({ ...payload, budget: snapshot.budget, conflicts: snapshot.conflicts });
  })
);

/** Cast (or change) a ballot. */
router.post(
  '/:voteId/cast',
  writeLimiter,
  requireTripRole('planner'),
  validate({ body: z.object({ candidateItemId: z.string().min(3) }) }),
  asyncHandler(async (req, res) => {
    const vote = await Vote.findOne({ _id: req.params.voteId, tripId: req.trip._id });
    if (!vote) throw ApiError.notFound('vote_not_found', 'Vote not found');

    const updated = await votes.castBallot({ vote, itemId: req.body.candidateItemId, userId: req.user._id });
    await boardService.logEvent(req.trip._id, 'vote.cast', {
      userId: req.user._id,
      payload: { voteId: String(updated._id), candidateItemId: req.body.candidateItemId },
    });

    const tally = votes.tally(updated);
    const payload = {
      voteId: String(updated._id),
      userId: String(req.user._id),
      candidateItemId: req.body.candidateItemId,
      counts: Object.fromEntries(tally.counts),
      ballotCount: updated.ballots.length,
    };
    hub.emitToTrip(req.trip._id, 'trip.vote.cast', payload);
    res.json(payload);
  })
);

/** Resolve a vote: tally, apply winner to the slot, clear losers. */
router.post(
  '/:voteId/resolve',
  writeLimiter,
  requireTripRole('planner'),
  asyncHandler(async (req, res) => {
    const vote = await Vote.findOne({ _id: req.params.voteId, tripId: req.trip._id });
    if (!vote) throw ApiError.notFound('vote_not_found', 'Vote not found');
    if (vote.status !== 'open') throw ApiError.conflict('vote_closed', 'This vote is already resolved');

    const { winner, losers, voteCount } = await votes.resolveVote({ vote });

    await boardService.logEvent(req.trip._id, 'vote.resolved', {
      userId: req.user._id,
      payload: { voteId: String(vote._id), winningItemId: vote.winningItemId ? String(vote.winningItemId) : null, resolution: vote.resolution },
    });

    const payload = {
      voteId: String(vote._id),
      winningItemId: vote.winningItemId ? String(vote.winningItemId) : null,
      winningItem: winner ? winner.toPublicJSON() : null,
      removedItemIds: losers,
      voteCount,
      resolution: vote.resolution,
      ballots: vote.ballots.length,
    };
    hub.emitToTrip(req.trip._id, 'trip.vote.resolved', payload);
    const snapshot = await boardService.afterMutation({ trip: req.trip, actorId: req.user._id });
    res.json({ ...payload, budget: snapshot.budget, conflicts: snapshot.conflicts });
  })
);

/** Cancel a live vote and return candidates to drafting. */
router.post(
  '/:voteId/cancel',
  writeLimiter,
  requireTripRole('leader'),
  asyncHandler(async (req, res) => {
    const vote = await Vote.findOne({ _id: req.params.voteId, tripId: req.trip._id });
    if (!vote) throw ApiError.notFound('vote_not_found', 'Vote not found');
    if (vote.status !== 'open') throw ApiError.conflict('vote_closed', 'This vote is already closed');

    vote.status = 'cancelled';
    vote.resolvedAt = new Date();
    await vote.save();

    const ItineraryItem = require('../models/ItineraryItem');
    await ItineraryItem.updateMany(
      { _id: { $in: vote.candidateItemIds } },
      { $set: { lifecycleStage: 'drafting' }, $inc: { positionVersion: 1 } }
    );

    hub.emitToTrip(req.trip._id, 'trip.vote.resolved', { voteId: String(vote._id), cancelled: true, winningItemId: null });
    const snapshot = await boardService.afterMutation({ trip: req.trip, actorId: req.user._id });
    res.json({ cancelled: true, voteId: String(vote._id), budget: snapshot.budget });
  })
);

router.get(
  '/:voteId',
  asyncHandler(async (req, res) => {
    const vote = await Vote.findOne({ _id: req.params.voteId, tripId: req.trip._id });
    if (!vote) throw ApiError.notFound('vote_not_found', 'Vote not found');
    res.json({ vote: vote.toPublicJSON(), tally: votes.tally(vote) });
  })
);

module.exports = router;
