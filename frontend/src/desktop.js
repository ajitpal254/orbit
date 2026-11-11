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

// Stories row (phones, M3): the friends worth showing are the ones
// actually around — in-room first, then online, never away. The
// presence endpoint already sorts in-room → online → away, so this
// just drops the away tail (and any entry without a status).
export function storiesFriends(friends) {
  return (friends || []).filter((f) => f.status === 'in-room' || f.status === 'online');
}

// Group consecutive activity rows with the same type and actor into
// one row with a count and the latest time — "3 new messages from
// Ajit Pal" instead of the same row three times. Only consecutive
// items merge: a different actor or type in between keeps the groups
// separate. Each group keeps the newest underlying notification, so
// a click still navigates (and marks read) using that id, and the
// unread dot shows if any item in the group is unread.
const GROUP_TEXT = {
  dm: (count, name) => `${count} new messages from ${name}`,
  friend_request: (count, name) => `${count} friend requests from ${name}`,
  room_invite: (count, name) => `${count} room invites from ${name}`,
  friend_accepted: (count, name) => `${count} friend requests accepted by ${name}`
};

function groupDisplayText(type, count, actorName, firstText) {
  if (count === 1) return firstText;
  const make = GROUP_TEXT[type];
  return make ? make(count, actorName) : `${count} notifications from ${actorName}`;
}

export function groupActivity(notifications) {
  const groups = [];
  for (const n of notifications || []) {
    const actorId = n.actor?.id ?? null;
    const last = groups[groups.length - 1];
    const time = new Date(n.updatedAt || n.createdAt).getTime();
    if (last && last.type === n.type && last.actorId === actorId) {
      last.items.push(n);
      last.count += 1;
      if (time > last.latestTime) {
        last.latestTime = time;
        last.latestAt = n.updatedAt || n.createdAt;
        last.newest = n;
      }
      if (!n.read) last.unread = true;
      last.text = groupDisplayText(last.type, last.count, last.actor?.name || 'someone', last.items[0].text);
    } else {
      groups.push({
        type: n.type,
        actorId,
        actor: n.actor || null,
        count: 1,
        items: [n],
        newest: n,
        latestAt: n.updatedAt || n.createdAt,
        latestTime: time,
        unread: !n.read,
        text: n.text
      });
    }
  }
  return groups;
}
