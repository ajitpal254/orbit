// Friends presence for the desktop right panel: map each accepted
// friend to a status derived from the live registries — no new data
// source, just a reshaping of what the socket layer already knows.
//
//   in-room — in a room the caller can see (room: { id, name })
//   online  — connected, but in no visible room
//   away    — no live socket
//
// Pure: the caller passes already-fetched data, so this is unit-testable
// without MongoDB or a socket server. The route (routes/api.js
// GET /api/friends/presence) builds `roomByUser` from lib/presence
// filtered through canSeeRoom, so a friend in a private room the caller
// cannot see shows as plain `online` — the room is never leaked.
//
// Sorted: in-room first, then online, then away; name within each group.
const STATUS_ORDER = { 'in-room': 0, online: 1, away: 2 };

const buildFriendPresence = (friends, onlineIds, roomByUser) => {
  const online = onlineIds instanceof Set ? onlineIds : new Set(onlineIds || []);
  const rooms = roomByUser instanceof Map ? roomByUser : new Map(Object.entries(roomByUser || {}));
  const rows = (friends || []).map((f) => {
    const id = String(f.id);
    const room = rooms.get(id) || null;
    const status = room ? 'in-room' : online.has(id) ? 'online' : 'away';
    return {
      id,
      name: f.name || '',
      email: f.email || '',
      avatarPreset: f.avatarPreset || null,
      avatarImage: f.avatarImage || '',
      status,
      room: room ? { id: String(room.id), name: room.name || '' } : null
    };
  });
  rows.sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    a.name.localeCompare(b.name));
  return rows;
};

module.exports = { buildFriendPresence };
