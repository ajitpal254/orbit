// Pure invite-link helpers: token generation/validation, expiry, and
// the permission predicates. No DB access here so these are
// unit-testable without MongoDB.
//
// Playbook (Orbit-Complete-Playbook-Edited.pdf, "Invite links — Join
// without searching. Expiring for private rooms."): links let someone
// join without searching, and links for private rooms expire. The
// playbook is silent on the details, so the safest readings apply:
//
//   - One active link per room (a second create returns the existing
//     link, like the pending room-invite flow returns the existing
//     invite). Revoking deletes it; creating again makes a fresh one.
//   - Private-room links expire 7 days after creation, set on the
//     server at creation time (never client-supplied). Public-room
//     links never expire — a public room is open to everyone anyway,
//     so its link grants nothing extra. Expiry is enforced in the
//     join path at read time; the TTL index on the model is only
//     storage cleanup (same pattern as fading chat).
//   - Private-room links admit only accepted friends of the link
//     creator — the same rule as room invites (inviter ↔ invitee
//     friendship, lib/friends.js canInvite). A member joining via
//     link skips the friend check (they are already in). Public-room
//     links admit anyone with the link.
//   - Create: any member for a private room (same as inviting), any
//     signed-in user for a public room.
//   - Revoke: the link's creator, or the room creator/owner.
//     Moderators cannot revoke — revocation is an ownership-level
//     action, and mods already have kick/mute for day-to-day control.
//
// Tokens are crypto-random (32 base64url chars from 24 random bytes —
// never sequential, never derived from the room id). Lookups use the
// SHA-256 hash (lib/passwords.js hashToken, same as session tokens),
// and the token itself is also stored AES-256-GCM encrypted
// (lib/crypto.js, same as room topics and chat text) so an authorized
// user can copy the link again later without invalidating the one
// already shared — revoking deletes the row, so the token dies with
// it. The raw token is never stored in plaintext and never logged.

const crypto = require('crypto');
const { areFriends, isRoomMember } = require('./friends');

// 7 days, in milliseconds. Private-room links live this long.
const PRIVATE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// A fresh unguessable token: 24 random bytes, base64url (URL-safe, no
// padding) — 32 characters, ~192 bits of entropy.
const generateInviteToken = () => crypto.randomBytes(24).toString('base64url');

// Strict token shape: exactly the 32 base64url chars generateInviteToken
// produces. Anything else (wrong length, bad characters, non-string) is
// not a token — rejected before any DB lookup.
const isValidInviteToken = (token) =>
  typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token);

// Server-set expiry for a new link on this room: 7 days out for a
// private room, null (never expires) for a public one. `now` is
// injectable for tests; defaults to Date.now().
const expiryForRoom = (room, now = Date.now()) =>
  room && room.isPrivate ? new Date(now + PRIVATE_LINK_TTL_MS) : null;

// Has this stored link expired? A link with no expiresAt never
// expires. The boundary is inclusive: expiresAt <= now is expired
// (same convention as fading chat's notExpiredFilter).
const isLinkExpired = (link, now = Date.now()) => {
  if (!link || !link.expiresAt) return false;
  return new Date(link.expiresAt).getTime() <= now;
};

// Who may create (or fetch) the room's link: any member for a private
// room, any signed-in user for a public room.
const canCreateInviteLink = (room, userId) => {
  if (!room || userId == null) return false;
  if (!room.isPrivate) return true;
  return isRoomMember(room, userId);
};

// Who may revoke the room's link: its creator, or the room creator
// (owner). Moderators and other members may not.
const canRevokeInviteLink = (room, link, userId) => {
  if (!room || !link || userId == null) return false;
  const me = String(userId);
  return String(link.createdBy) === me || String(room.createdBy) === me;
};

// May this user join this room with this link? Already-members always
// can (joining again just re-opens the room); public rooms admit
// anyone with the link; a private room admits only an accepted friend
// of the link creator. `friendRows` are the Friendship rows between
// the link creator and the joiner (either direction).
const canJoinViaLink = (room, link, userId, friendRows = []) => {
  if (!room || !link || userId == null) return false;
  if (isRoomMember(room, userId)) return true;
  if (!room.isPrivate) return true;
  return areFriends(friendRows, link.createdBy, userId);
};

module.exports = {
  PRIVATE_LINK_TTL_MS,
  generateInviteToken,
  isValidInviteToken,
  expiryForRoom,
  isLinkExpired,
  canCreateInviteLink,
  canRevokeInviteLink,
  canJoinViaLink
};
