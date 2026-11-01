'use strict';

const express = require('express');
const { z } = require('zod');
const mongoose = require('mongoose');

const Trip = require('../models/Trip');
const ItineraryItem = require('../models/ItineraryItem');
const Venue = require('../models/Venue');
const User = require('../models/User');
const Event = require('../models/Event');
const Vote = require('../models/Vote');

const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate } = require('../middleware/validate');
const { requireAuth, loadTrip, requireTripRole } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { generateInviteCode } = require('../utils/ids');
const { slugify, sanitizeText } = require('../utils/sanitize');
const { tripDayCount } = require('../utils/time');
const boardService = require('../services/boardService');
const { buildSessionAnalytics } = require('../services/analytics');
const { detectConflicts } = require('../services/conflicts');
const { resolveExpiredVotes } = require('../services/votes');
const hub = require('../realtime/hub');

const router = express.Router();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const createTripSchema = z
  .object({
    destination: z.string().min(2).max(120),
    startDate: dateSchema,
    endDate: dateSchema,
    totalBudget: z.number().positive().max(10_000_000),
    maxParticipants: z.number().int().min(2).max(50).optional(),
    budgetMode: z.enum(['even', 'weighted']).optional(),
    currency: z.string().length(3).optional(),
  })
  .refine((v) => new Date(v.endDate) >= new Date(v.startDate), {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  })
  .refine((v) => tripDayCount(v.startDate, v.endDate) <= 30, {
    message: 'Trip length is capped at 30 days',
    path: ['endDate'],
  });

router.use(requireAuth);

/** Create a Trip Room. Destination must exist in the authored venue catalog. */
router.post(
  '/',
  writeLimiter,
  validate({ body: createTripSchema }),
  asyncHandler(async (req, res) => {
    const { destination, startDate, endDate, totalBudget, maxParticipants, budgetMode, currency } = req.body;
    const destinationSlug = slugify(destination);

    const venues = await Venue.find({ destinationSlug }).lean();
    if (venues.length === 0) {
      const available = await Venue.distinct('destination');
      throw ApiError.badRequest(
        'unknown_destination',
        `No venue dataset is loaded for "${destination}". Available destinations: ${available.join(', ') || 'none'}`,
        { available }
      );
    }

    const coordinates = {
      lat: venues.reduce((sum, v) => sum + v.coordinates.lat, 0) / venues.length,
      lng: venues.reduce((sum, v) => sum + v.coordinates.lng, 0) / venues.length,
    };

    let inviteCode = generateInviteCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const clash = await Trip.exists({ inviteCode });
      if (!clash) break;
      inviteCode = generateInviteCode();
    }

    const trip = await Trip.create({
      destination: venues[0].destination,
      destinationSlug,
      coordinates,
      startDate,
      endDate,
      totalBudgetCents: Math.round(totalBudget * 100),
      currency: (currency || 'USD').toUpperCase(),
      maxParticipants: maxParticipants || 8,
      budgetMode: budgetMode || 'even',
      inviteCode,
      leaderUserId: req.user._id,
      members: [{ userId: req.user._id, role: 'leader', weight: 1, joinedAt: new Date() }],
      correlationId: `cid_${tripIdFragment()}`,
      planningStartedAt: new Date(),
    });

    await boardService.logEvent(trip._id, 'trip.created', { userId: req.user._id, payload: { destination: trip.destination } });

    res.status(201).json({
      tripId: String(trip._id),
      inviteCode: trip.inviteCode,
      status: trip.status,
      leaderUserId: String(trip.leaderUserId),
      destination: trip.destination,
      startDate: trip.startDate,
      endDate: trip.endDate,
      totalBudgetCents: trip.totalBudgetCents,
      maxParticipants: trip.maxParticipants,
      createdAt: trip.createdAt,
    });
  })
);

function tripIdFragment() {
  return new mongoose.Types.ObjectId().toString().slice(-8);
}

/** Trips the caller belongs to (admin sees all). */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = req.user.globalRole === 'admin' && req.query.all === 'true' ? {} : { 'members.userId': req.user._id };
    const trips = await Trip.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    const ids = trips.map((t) => t._id);

    const spendAgg = await ItineraryItem.aggregate([
      { $match: { tripId: { $in: ids } } },
      { $group: { _id: '$tripId', perPerson: { $sum: '$pricePerPersonCents' }, count: { $sum: 1 } } },
    ]);
    const spendByTrip = new Map(spendAgg.map((row) => [String(row._id), row]));

    res.json({
      trips: trips.map((trip) => {
        const spend = spendByTrip.get(String(trip._id)) || { perPerson: 0, count: 0 };
        const participants = trip.members.length;
        return {
          tripId: String(trip._id),
          destination: trip.destination,
          startDate: trip.startDate,
          endDate: trip.endDate,
          status: trip.status,
          inviteCode: trip.inviteCode,
          role: String(trip.leaderUserId) === String(req.user._id) ? 'leader' : (trip.members.find((m) => String(m.userId) === String(req.user._id))?.role || 'viewer'),
          participants,
          maxParticipants: trip.maxParticipants,
          itemCount: spend.count,
          groupSpendCents: spend.perPerson * participants,
          totalBudgetCents: trip.totalBudgetCents,
          createdAt: trip.createdAt,
          endedAt: trip.endedAt,
        };
      }),
    });
  })
);

/** Join by invite code. */
router.post(
  '/join',
  writeLimiter,
  validate({ body: z.object({ inviteCode: z.string().min(4).max(12) }) }),
  asyncHandler(async (req, res) => {
    const code = req.body.inviteCode.trim().toUpperCase();
    const trip = await Trip.findOne({ inviteCode: code });
    if (!trip) throw ApiError.notFound('invalid_invite_code', 'No trip matches that invite code');

    const existing = trip.memberFor(req.user._id);
    if (existing) {
      return res.json({ tripId: String(trip._id), role: trip.roleFor(req.user), alreadyMember: true, trip: trip.toPublicJSON() });
    }
    if (trip.members.length >= trip.maxParticipants) {
      throw ApiError.conflict('room_full', `This room is full (${trip.maxParticipants} planners)`);
    }
    if (trip.status === 'completed') {
      throw ApiError.conflict('trip_completed', 'This trip is completed and no longer accepting travelers');
    }

    const role = req.user.globalRole === 'viewer' ? 'viewer' : 'planner';
    trip.members.push({ userId: req.user._id, role, weight: 1, joinedAt: new Date() });
    await trip.save();

    await boardService.logEvent(trip._id, 'trip.joined', { userId: req.user._id, payload: { role } });
    hub.emitToTrip(trip._id, 'trip.presence.update', {
      participantId: String(req.user._id),
      name: req.user.displayName,
      action: 'joined',
      participantCount: hub.participantCount(trip._id),
    });

    return res.json({ tripId: String(trip._id), role, trip: trip.toPublicJSON() });
  })
);

/** Trip header + membership + settings. */
router.get(
  '/:id',
  loadTrip,
  asyncHandler(async (req, res) => {
    const { usersById } = await boardService.loadMembers(req.trip);
    res.json({
      trip: { ...req.trip.toPublicJSON(), tripId: String(req.trip._id) },
      role: req.tripRole,
      members: boardService.memberRows(req.trip, usersById),
      leaderState: hub.getLeaderState(req.trip._id),
    });
  })
);

/** Live board snapshot (items + budget + conflicts + open votes). */
router.get(
  '/:id/board',
  loadTrip,
  asyncHandler(async (req, res) => {
    const snapshot = await boardService.boardSnapshot(req.trip, { role: req.tripRole });
    res.json(snapshot);
  })
);

router.get(
  '/:id/conflicts',
  loadTrip,
  asyncHandler(async (req, res) => {
    const items = await boardService.activeItems(req.trip);
    const { usersById } = await boardService.loadMembers(req.trip);
    const conflicts = detectConflicts({ trip: req.trip, items, members: req.trip.members, usersById });
    res.json({ conflicts, checkedAt: new Date().toISOString() });
  })
);

/** Session analytics, derived from the event log and reconciled against the board. */
router.get(
  '/:id/analytics',
  loadTrip,
  asyncHandler(async (req, res) => {
    const [items, events, members] = await Promise.all([
      boardService.activeItems(req.trip),
      Event.find({ tripId: req.trip._id }).sort({ ts: 1 }).lean(),
      boardService.loadMembers(req.trip),
    ]);
    const analytics = buildSessionAnalytics({
      trip: req.trip,
      items,
      events,
      members: req.trip.members,
      usersById: members.usersById,
    });
    res.json({ analytics });
  })
);

/** Leader-only room settings. */
router.patch(
  '/:id',
  loadTrip,
  requireTripRole('leader'),
  validate({
    body: z.object({
      totalBudget: z.number().positive().max(10_000_000).optional(),
      maxParticipants: z.number().int().min(2).max(50).optional(),
      budgetMode: z.enum(['even', 'weighted']).optional(),
      roomLocked: z.boolean().optional(),
      destination: z.string().min(2).max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { totalBudget, maxParticipants, budgetMode, roomLocked } = req.body;
    if (totalBudget !== undefined) req.trip.totalBudgetCents = Math.round(totalBudget * 100);
    if (maxParticipants !== undefined) {
      if (maxParticipants < req.trip.members.length) {
        throw ApiError.badRequest('capacity_too_small', 'Capacity cannot be lower than the current participant count');
      }
      req.trip.maxParticipants = maxParticipants;
    }
    if (budgetMode !== undefined) req.trip.budgetMode = budgetMode;
    if (roomLocked !== undefined) req.trip.roomLocked = roomLocked;
    await req.trip.save();

    const snapshot = await boardService.afterMutation({ trip: req.trip, actorId: req.user._id });
    hub.emitToTrip(req.trip._id, 'trip.room.settings', {
      roomLocked: req.trip.roomLocked,
      totalBudgetCents: req.trip.totalBudgetCents,
      maxParticipants: req.trip.maxParticipants,
      budgetMode: req.trip.budgetMode,
    });
    res.json({ trip: req.trip.toPublicJSON(), budget: snapshot.budget });
  })
);

/** Mark the trip complete (read-only archive + analytics freeze). */
router.post(
  '/:id/complete',
  loadTrip,
  requireTripRole('leader'),
  asyncHandler(async (req, res) => {
    req.trip.status = 'completed';
    req.trip.endedAt = new Date();
    await req.trip.save();
    await resolveExpiredVotes({ tripId: req.trip._id });
    await boardService.logEvent(req.trip._id, 'trip.locked', { userId: req.user._id });
    hub.emitToTrip(req.trip._id, 'trip.room.settings', { status: 'completed' });
    res.json({ trip: req.trip.toPublicJSON() });
  })
);

/** Add an existing account to the room by email (Leader only). */
router.post(
  '/:id/invite',
  loadTrip,
  requireTripRole('leader'),
  validate({
    body: z.object({
      email: z.string().email(),
      role: z.enum(['viewer', 'planner']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const invitee = await User.findOne({ email: req.body.email.toLowerCase() });
    if (!invitee) throw ApiError.notFound('user_not_found', 'No account with that email');
    if (req.trip.memberFor(invitee._id)) {
      throw ApiError.conflict('already_member', 'That traveler is already in this room');
    }
    if (req.trip.members.length >= req.trip.maxParticipants) {
      throw ApiError.conflict('room_full', `This room is full (${req.trip.maxParticipants} planners)`);
    }
    req.trip.members.push({
      userId: invitee._id,
      role: req.body.role || (invitee.globalRole === 'viewer' ? 'viewer' : 'planner'),
      weight: 1,
      joinedAt: new Date(),
    });
    await req.trip.save();
    await boardService.logEvent(req.trip._id, 'trip.joined', { userId: invitee._id, payload: { invitedBy: String(req.user._id) } });
    res.status(201).json({ invited: { userId: String(invitee._id), name: invitee.displayName, email: invitee.email } });
  })
);

/** Leader moderation: role change, mute, weight (for weighted splits), removal. */
router.patch(
  '/:id/members/:userId',
  loadTrip,
  requireTripRole('leader'),
  validate({
    body: z.object({
      role: z.enum(['viewer', 'planner']).optional(),
      muted: z.boolean().optional(),
      weight: z.number().min(0.1).max(10).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const member = req.trip.memberFor(req.params.userId);
    if (!member) throw ApiError.notFound('member_not_found', 'That traveler is not in this room');
    if (String(member.userId) === String(req.trip.leaderUserId)) {
      throw ApiError.badRequest('cannot_modify_leader', 'Transfer the Leader role before changing your own membership');
    }
    if (req.body.role !== undefined) member.role = req.body.role;
    if (req.body.muted !== undefined) member.muted = req.body.muted;
    if (req.body.weight !== undefined) member.weight = req.body.weight;
    await req.trip.save();

    const snapshot = await boardService.afterMutation({ trip: req.trip, actorId: req.user._id });
    res.json({ member: { userId: String(member.userId), role: member.role, muted: member.muted, weight: member.weight }, budget: snapshot.budget });
  })
);

router.delete(
  '/:id/members/:userId',
  loadTrip,
  requireTripRole('leader'),
  asyncHandler(async (req, res) => {
    if (String(req.params.userId) === String(req.trip.leaderUserId)) {
      throw ApiError.badRequest('cannot_remove_leader', 'The Leader cannot be removed from their own room');
    }
    const before = req.trip.members.length;
    req.trip.members = req.trip.members.filter((m) => String(m.userId) !== String(req.params.userId));
    if (req.trip.members.length === before) throw ApiError.notFound('member_not_found', 'That traveler is not in this room');
    await req.trip.save();

    await boardService.logEvent(req.trip._id, 'trip.left', { userId: req.params.userId, payload: { removedBy: String(req.user._id) } });
    const snapshot = await boardService.afterMutation({ trip: req.trip, actorId: req.user._id });
    hub.emitToTrip(req.trip._id, 'trip.member.removed', { userId: req.params.userId });
    res.json({ removed: req.params.userId, budget: snapshot.budget });
  })
);

/** Transfer the Leader role deterministically to another member. */
router.post(
  '/:id/transfer-leader',
  loadTrip,
  requireTripRole('leader'),
  validate({ body: z.object({ userId: z.string().min(3) }) }),
  asyncHandler(async (req, res) => {
    const target = req.trip.memberFor(req.body.userId);
    if (!target) throw ApiError.notFound('member_not_found', 'That traveler is not in this room');

    const previousLeader = req.trip.leaderUserId;
    req.trip.members.forEach((m) => {
      if (String(m.userId) === String(previousLeader)) m.role = 'planner';
    });
    target.role = 'leader';
    req.trip.leaderUserId = target.userId;
    await req.trip.save();

    await boardService.logEvent(req.trip._id, 'leader.changed', {
      userId: req.user._id,
      payload: { from: String(previousLeader), to: String(target.userId), reason: 'transfer' },
    });
    hub.emitToTrip(req.trip._id, 'trip.leader.state', {
      leaderUserId: String(target.userId),
      leaderDisconnected: false,
      promoted: false,
      participantCount: hub.participantCount(req.trip._id),
    });
    res.json({ trip: req.trip.toPublicJSON() });
  })
);

/** Votes for this trip (open + resolved history). */
router.get(
  '/:id/votes',
  loadTrip,
  asyncHandler(async (req, res) => {
    const votes = await Vote.find({ tripId: req.trip._id }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({ votes: votes.map((v) => ({ ...v, voteId: String(v._id), _id: undefined })) });
  })
);

/** Chat transcript (last 100 messages) for initial render. */
router.get(
  '/:id/chat',
  loadTrip,
  asyncHandler(async (req, res) => {
    const ChatMessage = require('../models/ChatMessage');
    const messages = await ChatMessage.find({ tripId: req.trip._id }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({
      messages: messages.reverse().map((m) => ({
        ...m,
        messageId: String(m._id),
        _id: undefined,
        userId: m.userId ? String(m.userId) : null,
        tripId: String(m.tripId),
        reactions: (m.reactions || []).map((r) => ({ emoji: r.emoji, userIds: r.userIds.map(String) })),
      })),
    });
  })
);

// Nested resources: /trips/:id/items, /trips/:id/votes, /trips/:id/ai
router.use('/:id/items', require('./items'));
router.use('/:id/votes', require('./votes'));
router.use('/:id/ai', require('./ai'));

module.exports = router;
