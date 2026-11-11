// Desktop 3-zone helpers (pure, unit-tested in tests/desktop.test.mjs):
// picking the live hero room and shaping its occupants for the orb
// renderer. No fetching here — callers pass the room list Home already
// loads from GET /api/rooms.

// The hero room is the busiest live room: most occupants, then most
// people actually speaking, then first in list order (the list is
// already sorted live-first by recency). Returns null when nobody is
// live, so the caller shows the calm empty state instead of fake
// activity.
export function selectBusiestRoom(rooms) {
  let best = null;
  let bestCount = 0;
  let bestSpeaking = -1;
  for (const room of rooms || []) {
    const count = room.occupantCount || 0;
    if (count === 0) continue;
    const speaking = (room.occupants || []).filter((o) => o.speaking).length;
    if (count > bestCount || (count === bestCount && speaking > bestSpeaking)) {
      best = room;
      bestCount = count;
      bestSpeaking = speaking;
    }
  }
  return best;
}

// Shape a room's REST occupants for orbPositions (which keys people by
// socketId, falling back to id). The hero orbs are display-only —
// speaking glow comes from the REST speaking flag, no voice engine.
export function heroOccupants(room) {
  return (room?.occupants || []).map((o) => ({
    socketId: o.userId,
    userId: o.userId,
    name: o.name || 'Friend',
    speaking: !!o.speaking
  }));
}
