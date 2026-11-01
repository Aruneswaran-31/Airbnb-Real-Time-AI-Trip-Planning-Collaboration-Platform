'use strict';

/**
 * Board Sync Gateway (Socket.io).
 *
 * One namespaced connection per client, one Socket.io room per trip. All events
 * use the PRD envelope: { event, tripId, payload, ts }.
 *
 * Responsibilities:
 *  - JWT authentication at handshake time
 *  - fan-out of board/chat/vote/AI events to every connected planner
 *  - presence + typing indicators
 *  - deterministic leader-disconnect handling (promote an online planner, else
 *    freeze lock/finalize actions until the leader returns)
 *  - reconnect/resync: a joining or reconnecting client gets a full board snapshot
 */

const Trip = require('../models/Trip');
const Vote = require('../models/Vote');
const User = require('../models/User');

const { verifyAccessToken } = require('../middleware/auth');
const { ApiError } = require('../middleware/errors');
const boardService = require('../services/boardService');
const voteService = require('../services/votes');
const { performAiAsk } = require('../services/aiExchange');
const { sanitizeText } = require('../utils/sanitize');
const hub = require('./hub');
const logger = require('../logger');

// Simple per-socket chat throttle (10 messages / 10s).
function allowChat(socket) {
  const now = Date.now();
  socket.data.chatTimes = (socket.data.chatTimes || []).filter((ts) => now - ts < 10000);
  if (socket.data.chatTimes.length >= 10) return false;
  socket.data.chatTimes.push(now);
  return true;
}

async function authenticate(socket) {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.query?.token ||
    (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw ApiError.unauthorized('missing_token', 'A JWT is required to open a socket');
  const claims = verifyAccessToken(token);
  const user = await User.findById(claims.sub);
  if (!user) throw ApiError.unauthorized('unknown_user', 'User no longer exists');
  if ((user.tokenVersion || 0) !== claims.tv) throw ApiError.unauthorized('token_revoked', 'Session revoked');
  return user;
}

function register(io) {
  hub.setIO(io);

  io.use(async (socket, next) => {
    try {
      socket.data.user = await authenticate(socket);
      next();
    } catch (err) {
      next(new Error(err.message || 'unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.data.joinedTrips = new Set();
    logger.debug('socket connected', { userId: String(user._id), socketId: socket.id });

    socket.emit('trip.socket.ready', {
      event: 'trip.socket.ready',
      payload: { userId: String(user._id), name: user.displayName, serverTime: new Date().toISOString() },
      ts: Date.now(),
    });

    const fail = (tripId, err) => {
      const status = err instanceof ApiError ? err.status : 500;
      socket.emit('trip.error', {
        event: 'trip.error',
        tripId: tripId ? String(tripId) : null,
        payload: {
          status,
          code: err.code || 'internal_error',
          message: err.message || 'Unexpected error',
          details: err.details || null,
        },
        ts: Date.now(),
      });
    };

    const joinRoom = async (tripId, { resync = true } = {}) => {
      const trip = await Trip.findById(tripId);
      if (!trip) throw ApiError.notFound('trip_not_found', 'Trip room not found');

      const role = trip.roleFor(user);
      if (!role) throw ApiError.forbidden('not_a_member', 'Join the trip with its invite code first');
      if (trip.status === 'completed') throw ApiError.conflict('trip_completed', 'This trip is completed and read-only');

      const room = hub.room(trip._id);
      if (!socket.data.joinedTrips.has(String(trip._id))) {
        await socket.join(room);
        socket.data.joinedTrips.add(String(trip._id));

        hub.addPresence(trip._id, user, socket.id, { role });
        await boardService.logEvent(trip._id, 'presence.joined', { userId: user._id });

        trip.peakConcurrentPlanners = Math.max(trip.peakConcurrentPlanners || 0, hub.participantCount(trip._id));
        await trip.save();

        hub.emitToTrip(trip._id, 'trip.presence.update', {
          participantId: String(user._id),
          name: user.displayName,
          action: 'joined',
          participantCount: hub.participantCount(trip._id),
          participants: hub.presenceList(trip._id),
        });
      }

      // Leader connectivity: clear the freeze when the leader returns.
      if (String(trip.leaderUserId) === String(user._id)) {
        hub.setLeaderState(trip._id, { online: true, frozen: false, leaderUserId: String(user._id) });
        hub.emitToTrip(trip._id, 'trip.leader.state', {
          leaderUserId: String(user._id),
          leaderDisconnected: false,
          frozen: false,
          participantCount: hub.participantCount(trip._id),
        });
      }

      await voteService.resolveExpiredVotes({ tripId: trip._id });

      if (resync) {
        const snapshot = await boardService.boardSnapshot(trip, { role });
        socket.emit('trip.board.snapshot', {
          event: 'trip.board.snapshot',
          tripId: String(trip._id),
          payload: { ...snapshot, you: { userId: String(user._id), name: user.displayName, role } },
          ts: Date.now(),
        });
      }

      return { trip, role };
    };

    socket.on('trip.join', async (msg, ack) => {
      try {
        const tripId = msg?.tripId || msg?.payload?.tripId;
        const { trip, role } = await joinRoom(tripId);
        if (typeof ack === 'function') ack({ ok: true, tripId: String(trip._id), role });
      } catch (err) {
        fail(msg?.tripId, err);
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    socket.on('trip.leave', async (msg) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      if (!tripId) return;
      socket.leave(hub.room(tripId));
      socket.data.joinedTrips.delete(String(tripId));
      const result = hub.removePresence(tripId, user._id, socket.id);
      if (result?.removed) {
        await boardService.logEvent(tripId, 'presence.left', { userId: user._id });
        hub.emitToTrip(tripId, 'trip.presence.update', {
          participantId: String(user._id),
          name: user.displayName,
          action: 'left',
          participantCount: hub.participantCount(tripId),
          participants: hub.presenceList(tripId),
        });
      }
    });

    const requireRoom = async (tripId) => {
      const trip = await Trip.findById(tripId);
      if (!trip) throw ApiError.notFound('trip_not_found', 'Trip room not found');
      const role = trip.roleFor(user);
      if (!role) throw ApiError.forbidden('not_a_member', 'You are not a participant in this trip');
      return { trip, role };
    };

    socket.on('trip.board.pin', async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        const { trip, role } = await requireRoom(tripId);
        const result = await boardService.pinItem({ trip, user, role, input: msg.payload || msg });
        if (typeof ack === 'function') ack({ ok: true, itemId: result.item.itemId, positionVersion: result.item.positionVersion });
      } catch (err) {
        fail(tripId, err);
        if (typeof ack === 'function') ack({ ok: false, code: err.code, message: err.message });
      }
    });

    socket.on('trip.board.move', async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        const { trip, role } = await requireRoom(tripId);
        const payload = msg.payload || msg;
        const result = await boardService.moveItem({
          trip,
          user,
          role,
          itemId: payload.itemId,
          dayIndex: payload.dayIndex,
          startTime: payload.startTime,
          endTime: payload.endTime,
          expectedVersion: payload.expectedVersion,
        });

        if (result.conflict) {
          // Explicit conflict notification + current state so the UI can reconcile.
          hub.emitToSocket(socket, 'trip.board.conflict', tripId, {
            status: 'raised',
            conflictType: 'version',
            itemId: payload.itemId,
            expectedVersion: result.conflict.expectedVersion,
            currentVersion: result.conflict.currentVersion,
            currentItem: result.conflict.item,
            message: 'Another planner moved this item first — the board has been refreshed with their version.',
          });
          hub.emitToSocket(socket, 'trip.sync.resync', tripId, { item: result.conflict.item });
          if (typeof ack === 'function') ack({ ok: false, code: 'stale_version', item: result.conflict.item });
          return;
        }

        if (typeof ack === 'function') ack({ ok: true, positionVersion: result.item.positionVersion });
      } catch (err) {
        fail(tripId, err);
        if (typeof ack === 'function') ack({ ok: false, code: err.code, message: err.message });
      }
    });

    socket.on('trip.board.remove', async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        const { trip, role } = await requireRoom(tripId);
        const payload = msg.payload || msg;
        await boardService.removeItem({ trip, user, role, itemId: payload.itemId });
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        fail(tripId, err);
        if (typeof ack === 'function') ack({ ok: false, code: err.code, message: err.message });
      }
    });

    const lockHandler = (locked) => async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        const { trip, role } = await requireRoom(tripId);
        const payload = msg.payload || msg;
        await boardService.setItemLock({ trip, user, role, itemId: payload.itemId, locked });
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        fail(tripId, err);
        if (typeof ack === 'function') ack({ ok: false, code: err.code, message: err.message });
      }
    };

    socket.on('trip.board.lock', lockHandler(true));
    socket.on('trip.board.unlock', lockHandler(false));

    socket.on('trip.chat.send', async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        if (!allowChat(socket)) throw ApiError.tooMany('chat_rate_limited', 'You are sending messages too quickly');
        const { trip } = await requireRoom(tripId);
        const payload = msg.payload || msg;
        await boardService.postChatMessage({ trip, user, body: payload.body });
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        fail(tripId, err);
        if (typeof ack === 'function') ack({ ok: false, code: err.code, message: err.message });
      }
    });

    socket.on('trip.chat.typing', async (msg) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      if (!tripId) return;
      const payload = msg.payload || msg;
      socket.to(hub.room(tripId)).emit('trip.chat.typing', {
        event: 'trip.chat.typing',
        tripId: String(tripId),
        payload: {
          userId: String(user._id),
          name: user.displayName,
          isTyping: Boolean(payload.isTyping),
        },
        ts: Date.now(),
      });
    });

    socket.on('trip.chat.react', async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        const { trip } = await requireRoom(tripId);
        const payload = msg.payload || msg;
        await boardService.toggleReaction({
          trip,
          user,
          messageId: payload.messageId,
          emoji: payload.emoji || '👍',
        });
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        fail(tripId, err);
      }
    });

    socket.on('trip.vote.open', async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        const { trip } = await requireRoom(tripId);
        const payload = msg.payload || msg;
        const vote = await voteService.openVote({
          trip,
          actorId: user._id,
          candidateItemIds: payload.candidateItemIds,
          closesInSeconds: payload.closesInSeconds,
        });
        await boardService.logEvent(trip._id, 'vote.opened', {
          userId: user._id,
          payload: { voteId: String(vote._id), slot: vote.slot },
        });
        hub.emitToTrip(trip._id, 'trip.vote.open', {
          vote: { ...vote.toPublicJSON(), voteId: String(vote._id) },
          itemIds: vote.candidateItemIds.map(String),
        });
        await boardService.afterMutation({ trip, actorId: user._id });
        if (typeof ack === 'function') ack({ ok: true, voteId: String(vote._id) });
      } catch (err) {
        fail(tripId, err);
        if (typeof ack === 'function') ack({ ok: false, code: err.code, message: err.message });
      }
    });

    socket.on('trip.vote.cast', async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        const { trip } = await requireRoom(tripId);
        const payload = msg.payload || msg;
        const vote = await Vote.findOne({ _id: payload.voteId, tripId: trip._id });
        if (!vote) throw ApiError.notFound('vote_not_found', 'Vote not found');
        const updated = await voteService.castBallot({ vote, itemId: payload.candidateItemId, userId: user._id });
        await boardService.logEvent(trip._id, 'vote.cast', {
          userId: user._id,
          payload: { voteId: String(updated._id), candidateItemId: payload.candidateItemId },
        });
        const tally = voteService.tally(updated);
        hub.emitToTrip(trip._id, 'trip.vote.cast', {
          voteId: String(updated._id),
          userId: String(user._id),
          candidateItemId: payload.candidateItemId,
          counts: Object.fromEntries(tally.counts),
          ballotCount: updated.ballots.length,
        });
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        fail(tripId, err);
        if (typeof ack === 'function') ack({ ok: false, code: err.code, message: err.message });
      }
    });

    socket.on('trip.vote.resolve', async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        const { trip } = await requireRoom(tripId);
        const payload = msg.payload || msg;
        const vote = await Vote.findOne({ _id: payload.voteId, tripId: trip._id });
        if (!vote) throw ApiError.notFound('vote_not_found', 'Vote not found');
        const { winner, losers, voteCount } = await voteService.resolveVote({ vote });
        await boardService.logEvent(trip._id, 'vote.resolved', {
          userId: user._id,
          payload: { voteId: String(vote._id), winningItemId: vote.winningItemId ? String(vote.winningItemId) : null },
        });
        hub.emitToTrip(trip._id, 'trip.vote.resolved', {
          voteId: String(vote._id),
          winningItemId: vote.winningItemId ? String(vote.winningItemId) : null,
          winningItem: winner ? winner.toPublicJSON() : null,
          removedItemIds: losers,
          voteCount,
          resolution: vote.resolution,
        });
        await boardService.afterMutation({ trip, actorId: user._id });
        if (typeof ack === 'function') ack({ ok: true, winningItemId: vote.winningItemId ? String(vote.winningItemId) : null });
      } catch (err) {
        fail(tripId, err);
        if (typeof ack === 'function') ack({ ok: false, code: err.code, message: err.message });
      }
    });

    socket.on('trip.ai.ask', async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        const { trip } = await requireRoom(tripId);
        const payload = msg.payload || msg;
        const question = sanitizeText(payload.question, { maxLength: 500 });
        if (question.length < 3) throw ApiError.badRequest('invalid_question', 'Ask a longer question');
        const { result, message } = await performAiAsk({
          trip,
          user,
          question,
          anchorItemId: payload.anchorItemId || null,
        });
        hub.emitToTrip(trip._id, 'trip.chat.message', {
          message: { ...message.toPublicJSON(), tripId: String(trip._id), userId: null },
        });
        hub.emitToTrip(trip._id, 'trip.ai.suggestion', {
          questionId: result.questionId,
          userId: String(user._id),
          question,
          answer: result.answer,
          suggestedVenueId: result.suggestedVenueId,
          sourceEvents: result.sourceEvents,
          engine: result.engine,
          latencyMs: result.latencyMs,
          sources: result.sources,
          constraints: result.constraints,
          candidateStats: result.candidateStats,
          rejected: result.rejected,
          generatedAt: result.generatedAt,
        });
        if (typeof ack === 'function') ack({ ok: true, suggestedVenueId: result.suggestedVenueId });
      } catch (err) {
        fail(tripId, err);
        if (typeof ack === 'function') ack({ ok: false, code: err.code, message: err.message });
      }
    });

    socket.on('trip.moderate', async (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      try {
        const { trip, role } = await requireRoom(tripId);
        const payload = msg.payload || msg;
        if (['leader', 'admin'].indexOf(role) === -1) {
          throw ApiError.forbidden('insufficient_role', 'Only the Trip Leader can moderate this room');
        }

        if (payload.action === 'mute' || payload.action === 'unmute') {
          const member = trip.memberFor(payload.userId);
          if (!member) throw ApiError.notFound('member_not_found', 'That traveler is not in this room');
          member.muted = payload.action === 'mute';
          await trip.save();
          hub.emitToTrip(trip._id, 'trip.member.updated', { userId: String(payload.userId), muted: member.muted });
        } else if (payload.action === 'remove') {
          if (String(payload.userId) === String(trip.leaderUserId)) {
            throw ApiError.badRequest('cannot_remove_leader', 'The Leader cannot be removed');
          }
          trip.members = trip.members.filter((m) => String(m.userId) !== String(payload.userId));
          await trip.save();
          await boardService.logEvent(trip._id, 'trip.left', { userId: payload.userId, payload: { removedBy: String(user._id) } });
          hub.emitToTrip(trip._id, 'trip.member.removed', { userId: String(payload.userId) });
        } else if (payload.action === 'lock-room' || payload.action === 'unlock-room') {
          trip.roomLocked = payload.action === 'lock-room';
          await trip.save();
          hub.emitToTrip(trip._id, 'trip.room.settings', { roomLocked: trip.roomLocked });
        } else {
          throw ApiError.badRequest('unknown_action', `Unknown moderation action "${payload.action}"`);
        }

        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        fail(tripId, err);
        if (typeof ack === 'function') ack({ ok: false, code: err.code, message: err.message });
      }
    });

    socket.on('trip.sync.ping', (msg, ack) => {
      const tripId = msg?.tripId || msg?.payload?.tripId;
      const clientSentAt = (msg?.payload || msg)?.clientSentAt ?? Date.now();
      const payload = { clientSentAt, serverReceivedAt: Date.now(), serverTime: new Date().toISOString() };
      socket.emit('trip.sync.pong', {
        event: 'trip.sync.pong',
        tripId: tripId ? String(tripId) : null,
        payload,
        ts: Date.now(),
      });
      if (typeof ack === 'function') ack(payload);
    });

    /** Presence quality heartbeat: keeps the connection-quality chip honest. */
    socket.on('trip.presence.heartbeat', (msg) => {
      const tripId = msg?.tripId;
      const latencyMs = msg?.payload?.latencyMs;
      if (!tripId || typeof latencyMs !== 'number') return;
      hub.addPresence(tripId, user, socket.id, { latencyMs: Math.round(latencyMs) });
      hub.emitToTrip(tripId, 'trip.presence.update', {
        participantId: String(user._id),
        action: 'heartbeat',
        latencyMs: Math.round(latencyMs),
        participantCount: hub.participantCount(tripId),
        participants: hub.presenceList(tripId),
      });
    });

    socket.on('disconnect', async (reason) => {
      logger.debug('socket disconnected', { userId: String(user._id), reason });
      for (const tripId of [...socket.data.joinedTrips]) {
        const result = hub.removePresence(tripId, user._id, socket.id);
        if (!result?.removed) continue;

        await boardService.logEvent(tripId, 'presence.left', { userId: user._id });
        hub.emitToTrip(tripId, 'trip.presence.update', {
          participantId: String(user._id),
          name: user.displayName,
          action: 'left',
          participantCount: hub.participantCount(tripId),
          participants: hub.presenceList(tripId),
        });

        await handleLeaderDeparture({ tripId, userId: user._id });
      }
    });
  });

  // Close votes whose timer lapsed, even if nobody is clicking.
  const voteSweeper = setInterval(() => {
    voteService
      .resolveExpiredVotes()
      .then(async (resolved) => {
        for (const entry of resolved) {
          const tripId = entry.vote.tripId;
          hub.emitToTrip(tripId, 'trip.vote.resolved', {
            voteId: String(entry.vote._id),
            winningItemId: entry.vote.winningItemId ? String(entry.vote.winningItemId) : null,
            winningItem: entry.winner ? entry.winner.toPublicJSON() : null,
            removedItemIds: entry.losers,
            voteCount: entry.voteCount,
            resolution: entry.vote.resolution,
          });
          const TripModel = Trip;
          const trip = await TripModel.findById(tripId);
          if (trip) await boardService.afterMutation({ trip, actorId: null });
        }
      })
      .catch((err) => logger.warn('vote sweeper failed', { message: err.message }));
  }, 3000);
  voteSweeper.unref();

  return io;
}

/**
 * Deterministic leader-disconnect behaviour:
 *   1. if the leader has other live sockets, do nothing
 *   2. otherwise promote the longest-standing *connected* planner to Leader
 *   3. if no planner is connected, freeze lock/finalize actions until they return
 */
async function handleLeaderDeparture({ tripId, userId }) {
  const trip = await Trip.findById(tripId);
  if (!trip || String(trip.leaderUserId) !== String(userId)) return;
  if (hub.isUserOnline(tripId, userId)) return;

  const online = hub.presenceList(tripId);
  const candidates = trip.members
    .filter((m) => m.role === 'planner' && online.some((p) => p.userId === String(m.userId)))
    .sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt));

  if (candidates.length > 0) {
    const promoted = candidates[0];
    const previousLeader = trip.leaderUserId;

    trip.members.forEach((m) => {
      if (String(m.userId) === String(previousLeader)) m.role = 'planner';
      if (String(m.userId) === String(promoted.userId)) m.role = 'leader';
    });
    trip.leaderUserId = promoted.userId;
    await trip.save();

    hub.setLeaderState(tripId, { online: true, frozen: false, leaderUserId: String(promoted.userId) });
    await boardService.logEvent(tripId, 'leader.changed', {
      userId: null,
      payload: {
        from: String(previousLeader),
        to: String(promoted.userId),
        reason: 'leader_disconnected',
      },
    });

    const user = await User.findById(promoted.userId).select('displayName');
    hub.emitToTrip(tripId, 'trip.leader.state', {
      leaderUserId: String(promoted.userId),
      leaderDisconnected: true,
      promoted: true,
      promotedTo: { userId: String(promoted.userId), name: user ? user.displayName : 'Traveler' },
      frozen: false,
      message: 'The Trip Leader disconnected. A co-Planner has been promoted automatically.',
    });
    return;
  }

  hub.setLeaderState(tripId, { online: false, frozen: true, leaderUserId: String(userId) });
  hub.emitToTrip(tripId, 'trip.leader.state', {
    leaderUserId: String(userId),
    leaderDisconnected: true,
    promoted: false,
    frozen: true,
    message: 'The Trip Leader disconnected and no Planner is online. Lock and finalize actions are frozen until the Leader returns.',
  });
}

module.exports = { register, handleLeaderDeparture };
