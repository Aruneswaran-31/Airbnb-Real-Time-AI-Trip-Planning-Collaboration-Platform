'use strict';

/**
 * Process-wide realtime hub.
 *
 * Holds the Socket.io server plus per-room ephemeral state (presence, active
 * conflict fingerprints, leader connectivity). Board mutations broadcast through
 * here so REST writes and socket writes produce the same fan-out.
 */

const state = {
  io: null,
  presence: new Map(), // tripId -> Map(userId -> { socketIds: Set, userId, name, role, joinedAt, latencyMs })
  conflicts: new Map(), // tripId -> Set(conflictKey)
  leader: new Map(), // tripId -> { online, frozen, promotedTo }
};

function setIO(io) {
  state.io = io;
}

function getIO() {
  return state.io;
}

function room(tripId) {
  return `trip:${String(tripId)}`;
}

/** Every realtime message shares the PRD envelope. */
function envelope(event, tripId, payload) {
  return { event, tripId: String(tripId), payload, ts: Date.now() };
}

function emitToTrip(tripId, event, payload) {
  if (!state.io) return;
  state.io.to(room(tripId)).emit(event, envelope(event, tripId, payload));
}

function emitToSocket(socket, event, tripId, payload) {
  if (!socket) return;
  socket.emit(event, envelope(event, tripId, payload));
}

function addPresence(tripId, user, socketId, { role, latencyMs = null } = {}) {
  const key = String(tripId);
  if (!state.presence.has(key)) state.presence.set(key, new Map());
  const participants = state.presence.get(key);
  const id = String(user._id || user.userId);
  const existing = participants.get(id);
  if (existing) {
    existing.socketIds.add(socketId);
    if (role) existing.role = role;
    if (latencyMs !== null) existing.latencyMs = latencyMs;
    return existing;
  }
  const entry = {
    userId: id,
    name: user.displayName || user.name || 'Traveler',
    role: role || 'planner',
    socketIds: new Set([socketId]),
    joinedAt: Date.now(),
    latencyMs,
  };
  participants.set(id, entry);
  return entry;
}

function removePresence(tripId, userId, socketId) {
  const key = String(tripId);
  const participants = state.presence.get(key);
  if (!participants) return null;
  const id = String(userId);
  const entry = participants.get(id);
  if (!entry) return null;
  entry.socketIds.delete(socketId);
  if (entry.socketIds.size === 0) {
    participants.delete(id);
    if (participants.size === 0) state.presence.delete(key);
    return { removed: true, entry };
  }
  return { removed: false, entry };
}

function presenceList(tripId) {
  const participants = state.presence.get(String(tripId));
  if (!participants) return [];
  return [...participants.values()].map((p) => ({
    userId: p.userId,
    name: p.name,
    role: p.role,
    joinedAt: p.joinedAt,
    latencyMs: p.latencyMs,
    connections: p.socketIds.size,
  }));
}

function participantCount(tripId) {
  return presenceList(tripId).length;
}

function isUserOnline(tripId, userId) {
  return presenceList(tripId).some((p) => p.userId === String(userId));
}

function setConflictKeys(tripId, keys) {
  state.conflicts.set(String(tripId), keys);
}

function getConflictKeys(tripId) {
  return state.conflicts.get(String(tripId)) || new Set();
}

function clearRoom(tripId) {
  const key = String(tripId);
  state.conflicts.delete(key);
  state.leader.delete(key);
}

function setLeaderState(tripId, value) {
  state.leader.set(String(tripId), value);
}

function getLeaderState(tripId) {
  return state.leader.get(String(tripId)) || { online: true, frozen: false };
}

module.exports = {
  setIO,
  getIO,
  room,
  envelope,
  emitToTrip,
  emitToSocket,
  addPresence,
  removePresence,
  presenceList,
  participantCount,
  isUserOnline,
  setConflictKeys,
  getConflictKeys,
  clearRoom,
  setLeaderState,
  getLeaderState,
};
