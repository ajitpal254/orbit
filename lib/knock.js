// Pure knock predicates + helpers. No DB access here so these are
// unit-testable without MongoDB (playbook Prompt B item 2: "Pure
// predicate in lib/knock.js + tests").
//
// A knock is a non-member asking to be let into a private room. The
// room's owner (and moderators) are notified and admit or decline.
//
// Rules (playbook Prompt B item 2 + addendum §2 item 3, adapted from
// the playbook's person-to-person knock to the room knock this
// feature ships):
// - Friends-only, enforced on the server: the knocker must be an
//   accepted friend of the room's (current) owner — the owner is the
//   person being asked, so the friendship gate is with them. Same rule
//   as invites, where the invitee must be the inviter's friend. A
//   friend of some other member who is not the owner cannot knock;
//   they can ask that member to invite them instead.
// - Rate-limit: 1 knock per 30s per (knocker, room) pair. A repeat
//   knock while one is pending returns the existing knock instead of
//   a second row / a second notification.
// - Expiry: an unanswered knock expires after 24h (the playbook is
//   silent on knock expiry; 24h matches fading chat). Expiry is
//   enforced at READ time — the Mongo TTL index only cleans up
//   storage later (same pattern as fading chat).
// - Only the owner/moderators may admit or decline; only non-members
//   may knock. A knock on a faded/closed room fails before any of
//   this (the route checks isVisible first) — nobody is ever admitted
//   into a deleted room.
//
// Ids may be ObjectIds or strings — everything is compared as strings.

const { areFriends, isRoomMember } = require('./friends');
const { getRole } = require('./roles');

const s = (v) => String(v);

// Unanswered knocks expire after 24h.
const KNOCK_TTL_MS = 24 * 60 * 60 * 1000;
// One knock per 30s per (knocker, room) pair.
const KNOCK_RATE_LIMIT_MS = 30 * 1000;

// Server-side deadline for a knock created at `createdAt`.
const expiryForKnock = (createdAt = new Date()) =>
  new Date(new Date(createdAt).getTime() + KNOCK_TTL_MS);

// A knock whose deadline is at or before `now` is expired. A knock
// with no expiresAt (defensive — the route always sets one) never
// expires.
const isKnockExpired = (knock, now = new Date()) => {
  if (!knock || knock.expiresAt == null) return false;
  return new Date(knock.expiresAt).getTime() <= new Date(now).getTime();
};

// A knock that can still be answered: pending and unexpired.
const isKnockPending = (knock, now = new Date()) =>
  !!knock && knock.status === 'pending' && !isKnockExpired(knock, now);

// Is a new knock within the 30s per-pair window of `lastKnockAt`?
// Exactly 30s after the last knock the window has passed.
const isKnockRateLimited = (lastKnockAt, now = new Date()) => {
  if (!lastKnockAt) return false;
  return new Date(now).getTime() - new Date(lastKnockAt).getTime() < KNOCK_RATE_LIMIT_MS;
};

// Can userId knock on this room? Private rooms only, not already a
// member, and an accepted friend of the room's owner.
const canKnock = (room, userId, friendRows = []) => {
  if (!room || !room.isPrivate || userId == null) return false;
  if (isRoomMember(room, userId)) return false;
  return areFriends(friendRows, userId, room.createdBy);
};

// Why a knock is not allowed — the short reason the locked-room screen
// shows instead of a bare 403. '' when knocking is allowed.
const knockBlockReason = (room, userId, friendRows = []) => {
  if (!room) return 'Room not found';
  if (!room.isPrivate) return 'Only private rooms take knocks';
  if (isRoomMember(room, userId)) return 'You are already a member of this room';
  if (!areFriends(friendRows, userId, room.createdBy)) {
    return 'Only friends of the room owner can knock — ask them to invite you';
  }
  return '';
};

// Can userId answer (admit / decline) knocks on this room? Owner or
// moderator only — a plain member cannot let strangers in.
const canAnswerKnock = (room, userId) => {
  const role = getRole(room, userId);
  return role === 'owner' || role === 'moderator';
};

// The still-pending knock for (room, user), if one exists.
const findPendingKnock = (knocks = [], roomId, userId, now = new Date()) =>
  knocks.find((k) =>
    isKnockPending(k, now) &&
    s(k.room) === s(roomId) &&
    s(k.user) === s(userId)
  ) || null;

// Mongo read-time filter: expired knocks never reach a list — the TTL
// index only cleans up storage later.
const notExpiredKnockFilter = (now = new Date()) => ({
  $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date(now) } }]
});

// Serialize a knock with the room + knocker the UI needs. Room/user
// may be null (deleted user, stale row) — degrade, never crash.
const knockJson = (knock, room, user) => ({
  id: s(knock._id),
  room: room
    ? { id: s(room._id), name: room.name || '' }
    : { id: s(knock.room), name: '' },
  user: user
    ? {
        id: s(user._id),
        name: user.name || '',
        avatarPreset: user.avatarPreset || null,
        avatarImage: user.avatarImage || ''
      }
    : { id: s(knock.user), name: '', avatarPreset: null, avatarImage: '' },
  status: knock.status,
  createdAt: knock.createdAt,
  expiresAt: knock.expiresAt || null
});

module.exports = {
  KNOCK_TTL_MS,
  KNOCK_RATE_LIMIT_MS,
  expiryForKnock,
  isKnockExpired,
  isKnockPending,
  isKnockRateLimited,
  canKnock,
  knockBlockReason,
  canAnswerKnock,
  findPendingKnock,
  notExpiredKnockFilter,
  knockJson
};
