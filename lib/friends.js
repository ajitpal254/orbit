// Pure friendship / private-room predicates. No DB access here so these
// are unit-testable without MongoDB.
//
// Rows are plain objects with string ids:
//   friendship: { requester, recipient, status: 'pending' | 'accepted' }
//   invite:     { room, invitee, status: 'pending' | 'accepted' | 'declined' }
//   room:       { isPrivate, members: [id...], createdBy }
// Ids may be ObjectIds or strings — everything is compared as strings.

const s = (v) => String(v);

// Is there an accepted friendship between a and b, in either direction?
const areFriends = (rows = [], a, b) => {
  const x = s(a);
  const y = s(b);
  return rows.some((r) =>
    r.status === 'accepted' &&
    ((s(r.requester) === x && s(r.recipient) === y) ||
     (s(r.requester) === y && s(r.recipient) === x))
  );
};

// Friendship state between me and other, from all rows involving us:
// 'none' | 'pending-sent' | 'pending-received' | 'friends'.
const friendshipStatus = (rows = [], me, other) => {
  const x = s(me);
  const y = s(other);
  for (const r of rows) {
    const req = s(r.requester);
    const rec = s(r.recipient);
    if (req === x && rec === y) {
      return r.status === 'accepted' ? 'friends' : 'pending-sent';
    }
    if (req === y && rec === x) {
      return r.status === 'accepted' ? 'friends' : 'pending-received';
    }
  }
  return 'none';
};

// The other party of a friendship row, from my point of view.
const otherUserId = (row, me) =>
  s(row.requester) === s(me) ? s(row.recipient) : s(row.requester);

// Is userId a member of the room? The creator counts as a member even if
// an old private room's members list somehow misses them.
const isRoomMember = (room, userId) => {
  if (!room) return false;
  const id = s(userId);
  if (s(room.createdBy) === id) return true;
  return (room.members || []).some((m) => s(m) === id);
};

// Can userId see (list / open / chat in) the room? Public rooms are open
// to everyone; rooms without isPrivate set (created before private rooms
// existed) behave as public.
const canSeeRoom = (room, userId) => {
  if (!room) return false;
  if (!room.isPrivate) return true;
  return isRoomMember(room, userId);
};

// Can inviter invite invitee into the room? The inviter must be a member,
// the invitee must be the inviter's accepted friend, and the invitee must
// not already be a member.
const canInvite = (room, inviterId, inviteeId, friendRows = []) =>
  isRoomMember(room, inviterId) &&
  areFriends(friendRows, inviterId, inviteeId) &&
  !isRoomMember(room, inviteeId);

// The pending invite for (room, invitee), if one exists.
const findPendingInvite = (invites = [], roomId, inviteeId) =>
  invites.find((i) =>
    i.status === 'pending' &&
    s(i.room) === s(roomId) &&
    s(i.invitee) === s(inviteeId)
  ) || null;

module.exports = {
  areFriends, friendshipStatus, otherUserId,
  isRoomMember, canSeeRoom, canInvite, findPendingInvite
};
