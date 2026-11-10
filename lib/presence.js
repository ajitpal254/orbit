// In-memory live presence: who is in which room right now, and who is
// speaking. The source of truth for room occupancy (REST + socket.io share
// this registry). Pure in-memory — a restart just clears presence, which is
// correct: presence is ephemeral by nature.
const rooms = new Map(); // roomId -> Map(socketId -> { userId, name, speaking })

const addOccupant = (roomId, socketId, user) => {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  rooms.get(roomId).set(socketId, { userId: String(user.id), name: user.name, speaking: false });
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

const occupancyCount = (roomId) => rooms.get(roomId)?.size || 0;

const speakingUserIds = (roomId) =>
  occupants(roomId).filter((o) => o.speaking).map((o) => o.userId);

const clearAll = () => rooms.clear();

module.exports = {
  addOccupant, removeOccupant, removeSocketEverywhere,
  setSpeaking, occupants, occupancyCount, speakingUserIds, clearAll
};
