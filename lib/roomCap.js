// Room cap (v0.7.0): mesh voice works best at ~2-6 people and degrades
// past that, so rooms cap at 8 live occupants — the top of the 6-8
// range. The count is live presence (lib/presence.js), NOT the member
// list: a room with 8 people inside refuses entry even if it has more
// members. There are no exemptions — not even the owner or moderators —
// because the cap is about voice quality, not permission. Both the
// socket join-room handler (lib/socket.js) and the HTTP pre-flight
// (POST /api/rooms/:id/join in routes/api.js) use isRoomFull, so the
// two paths can never disagree.
const presence = require('./presence');

const MAX_ROOM_OCCUPANTS = 8;

// Friendly message, not a bare code: both join paths return this as
// `error` alongside code 'room-full', and the client shows it verbatim.
const ROOM_FULL_MESSAGE =
  'This room is full — 8 people are already in here. Try again when someone leaves.';

// True when the room already holds the cap. `exceptSocketId` is the
// socket rejoining a room it is already in: its own presence entry
// must not count against it, so a rejoin (or a reconnect that races
// the old socket's disconnect) is never refused as the 9th person.
const isRoomFull = (roomId, exceptSocketId) => {
  const occupants = presence.occupants(String(roomId));
  const count = exceptSocketId
    ? occupants.filter((o) => o.socketId !== exceptSocketId).length
    : occupants.length;
  return count >= MAX_ROOM_OCCUPANTS;
};

module.exports = { MAX_ROOM_OCCUPANTS, ROOM_FULL_MESSAGE, isRoomFull };
