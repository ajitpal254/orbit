// In-memory live presence: who is in which room right now, and who is
// speaking. The source of truth for room occupancy (REST + socket.io share
// this registry). Pure in-memory — a restart just clears presence, which is
// correct: presence is ephemeral by nature.
const { normalizeMood } = require('./mood');

const rooms = new Map(); // roomId -> Map(socketId -> { userId, name, speaking, mood })

const addOccupant = (roomId, socketId, user) => {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  // Mood rides with presence (see lib/mood.js): room-state and
  // user-joined carry it, so orbs glow without a second fetch. A
  // legacy caller passing no mood reads as the default.
  rooms.get(roomId).set(socketId, {
    userId: String(user.id), name: user.name, speaking: false,
    mood: normalizeMood(user.mood)
  });
};

// A mood change mid-room (socket 'mood'): the stored presence row
// updates so a late joiner's room-state already carries the new
// mood. Returns false when the socket is not in this room.
const setOccupantMood = (roomId, socketId, mood) => {
  const occupant = rooms.get(roomId)?.get(socketId);
  if (!occupant) return false;
  occupant.mood = normalizeMood(mood);
  return true;
};

const removeOccupant = (roomId, socketId) => {
  const occupants = rooms.get(roomId);
  if (!occupants) return null;
  const removed = occupants.get(socketId) || null;
  occupants.delete(socketId);
  if (occupants.size === 0) rooms.delete(roomId);
  return removed;
};

// Remove a socket from every room it was in; returns the rooms it left.
const removeSocketEverywhere = (socketId) => {
  const left = [];
  for (const [roomId, occupants] of rooms) {
    if (occupants.has(socketId)) {
      occupants.delete(socketId);
      left.push(roomId);
      if (occupants.size === 0) rooms.delete(roomId);
    }
  }
  return left;
};

const setSpeaking = (roomId, socketId, speaking) => {
  const occupant = rooms.get(roomId)?.get(socketId);
  if (!occupant) return false;
  occupant.speaking = Boolean(speaking);
  return true;
};

const occupants = (roomId) => {
  const map = rooms.get(roomId);
  if (!map) return [];
  return [...map.entries()].map(([socketId, o]) => ({ socketId, ...o }));
};

// Every occupied room with its occupants, as [{ roomId, occupants }].
// The friends-presence route uses this to find which (visible) room a
// friend is in, without exposing the raw registry.
const snapshot = () =>
  [...rooms.entries()].map(([roomId, map]) => ({
    roomId,
    occupants: [...map.entries()].map(([socketId, o]) => ({ socketId, ...o }))
  }));

// Which room a socket is currently in, or null when it is in no room.
// Socket-scoped (unlike roomOfUser): a user with two tabs can be in two
// rooms at once, and the signal relay must check the sending *socket*.
const roomOfSocket = (socketId) => {
  for (const [roomId, map] of rooms) {
    if (map.has(socketId)) return roomId;
  }
  return null;
};

// Which room a user is currently in (first match — a socket is in one
// room at a time in practice), or null when they are in no room.
const roomOfUser = (userId) => {
  const id = String(userId);
  for (const [roomId, map] of rooms) {
    for (const o of map.values()) {
      if (o.userId === id) return roomId;
    }
  }
  return null;
};

const occupancyCount = (roomId) => rooms.get(roomId)?.size || 0;

const speakingUserIds = (roomId) =>
  occupants(roomId).filter((o) => o.speaking).map((o) => o.userId);

const clearAll = () => rooms.clear();

module.exports = {
  addOccupant, removeOccupant, removeSocketEverywhere,
  setSpeaking, setOccupantMood, occupants, snapshot, roomOfUser, roomOfSocket,
  occupancyCount, speakingUserIds, clearAll
};
