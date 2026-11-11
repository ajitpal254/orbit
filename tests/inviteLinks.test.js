// Tests for invite links: the pure helpers in lib/inviteLinks.js and
// model validation for models/InviteLink.js (no MongoDB needed —
// validate() runs offline; unique indexes are only enforced by the
// database, so they are not asserted here).
//
// Coverage: token validation (bad/unknown tokens rejected), expiry
// (private links expire, public links never do, boundary cases),
// revocation permissions, and the private-room rule (non-friend cannot
// join a private room via link; accepted friend can; anyone can join
// a public room via link).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  PRIVATE_LINK_TTL_MS,
  generateInviteToken,
  isValidInviteToken,
  expiryForRoom,
  isLinkExpired,
  canCreateInviteLink,
  canRevokeInviteLink,
  canJoinViaLink
} = require('../lib/inviteLinks');
const { hashToken } = require('../lib/passwords');
const InviteLink = require('../models/InviteLink');

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MOD = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const MEMBER = 'cccccccccccccccccccccccc';
const FRIEND = 'dddddddddddddddddddddddd';
const STRANGER = 'eeeeeeeeeeeeeeeeeeeeeeee';
const ROOM_ID = 'ffffffffffffffffffffffff';

const privateRoom = {
  _id: ROOM_ID,
  isPrivate: true,
  createdBy: OWNER,
  members: [
    { user: OWNER, role: 'owner' },
    { user: MOD, role: 'moderator' },
    { user: MEMBER, role: 'member' }
  ]
};
const publicRoom = { _id: ROOM_ID, isPrivate: false, createdBy: OWNER, members: [] };

// Friendship rows between the link creator (OWNER) and FRIEND.
const friendRows = [{ requester: OWNER, recipient: FRIEND, status: 'accepted' }];
const pendingRows = [{ requester: OWNER, recipient: FRIEND, status: 'pending' }];

const linkBy = (createdBy, expiresAt = null) => ({
  room: ROOM_ID, createdBy, tokenHash: 'x'.repeat(64), expiresAt
});

test('generateInviteToken: 32 base64url chars, unique across many draws', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = generateInviteToken();
    assert.equal(typeof t, 'string');
    assert.equal(t.length, 32);
    assert.match(t, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(seen.has(t), false, 'duplicate token generated');
    seen.add(t);
  }
});

test('isValidInviteToken: rejects bad / unknown tokens before any lookup', () => {
  const good = generateInviteToken();
  assert.equal(isValidInviteToken(good), true);
  // Wrong length, bad characters, wrong type, empty — all rejected.
  assert.equal(isValidInviteToken(good.slice(0, 31)), false);
  assert.equal(isValidInviteToken(good + 'A'), false);
  assert.equal(isValidInviteToken(good.slice(0, 16) + '+' + good.slice(17)), false);
  assert.equal(isValidInviteToken(good.slice(0, 16) + '/' + good.slice(17)), false);
  assert.equal(isValidInviteToken(good.slice(0, 16) + '=' + good.slice(17)), false);
  assert.equal(isValidInviteToken(''), false);
  assert.equal(isValidInviteToken(null), false);
  assert.equal(isValidInviteToken(undefined), false);
  assert.equal(isValidInviteToken(123), false);
  assert.equal(isValidInviteToken({}), false);
  // A well-formed token from another room is still well-formed — the
  // DB lookup (not the shape check) is what rejects unknown tokens.
  assert.equal(isValidInviteToken(generateInviteToken()), true);
});

test('stored token is a hash, never the raw token', () => {
  const token = generateInviteToken();
  const stored = hashToken(token);
  assert.equal(stored.length, 64);
  assert.equal(stored.includes(token), false);
  assert.equal(hashToken(token), stored, 'hashing is deterministic');
  assert.notEqual(hashToken(generateInviteToken()), stored);
});

test('expiryForRoom: private links expire in 7 days, public links never', () => {
  const now = Date.now();
  const priv = expiryForRoom(privateRoom, now);
  assert.ok(priv instanceof Date);
  assert.equal(priv.getTime() - now, PRIVATE_LINK_TTL_MS);
  assert.equal(PRIVATE_LINK_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(expiryForRoom(publicRoom, now), null);
  // Rooms created before isPrivate existed behave as public.
  assert.equal(expiryForRoom({ createdBy: OWNER }, now), null);
});

test('isLinkExpired: boundary cases — just before, at, just after', () => {
  const now = Date.now();
  const at = (ms) => ({ expiresAt: new Date(now + ms) });
  assert.equal(isLinkExpired(at(-1), now), true);
  assert.equal(isLinkExpired(at(0), now), true, 'expiresAt == now is expired');
  assert.equal(isLinkExpired(at(1), now), false);
  assert.equal(isLinkExpired(at(60 * 1000), now), false);
  // No expiresAt (public-room link) never expires; no link at all is
  // not "expired" — it is simply absent (the caller 404s).
  assert.equal(isLinkExpired({ expiresAt: null }, now), false);
  assert.equal(isLinkExpired({}, now), false);
  assert.equal(isLinkExpired(null, now), false);
});

test('canCreateInviteLink: any member for private rooms, anyone for public', () => {
  assert.equal(canCreateInviteLink(privateRoom, OWNER), true);
  assert.equal(canCreateInviteLink(privateRoom, MOD), true);
  assert.equal(canCreateInviteLink(privateRoom, MEMBER), true);
  assert.equal(canCreateInviteLink(privateRoom, STRANGER), false);
  assert.equal(canCreateInviteLink(privateRoom, FRIEND), false);
  assert.equal(canCreateInviteLink(publicRoom, STRANGER), true);
  assert.equal(canCreateInviteLink(publicRoom, null), false);
  assert.equal(canCreateInviteLink(null, OWNER), false);
});

test('canRevokeInviteLink: creator or room owner only — mods cannot', () => {
  const link = linkBy(OWNER);
  assert.equal(canRevokeInviteLink(privateRoom, link, OWNER), true, 'creator revokes');
  assert.equal(canRevokeInviteLink(privateRoom, link, MOD), false, 'moderator cannot revoke');
  assert.equal(canRevokeInviteLink(privateRoom, link, MEMBER), false, 'plain member cannot revoke');
  assert.equal(canRevokeInviteLink(privateRoom, link, STRANGER), false);
  // The room owner can revoke a link created by someone else.
  const othersLink = linkBy(MEMBER);
  assert.equal(canRevokeInviteLink(privateRoom, othersLink, OWNER), true, 'owner revokes any link');
  assert.equal(canRevokeInviteLink(privateRoom, othersLink, MEMBER), true, 'creator revokes own link');
  assert.equal(canRevokeInviteLink(privateRoom, othersLink, MOD), false);
  // Public rooms: the room creator plays the owner role.
  assert.equal(canRevokeInviteLink(publicRoom, linkBy(MEMBER), OWNER), true);
  assert.equal(canRevokeInviteLink(publicRoom, linkBy(MEMBER), STRANGER), false);
  assert.equal(canRevokeInviteLink(privateRoom, null, OWNER), false);
  assert.equal(canRevokeInviteLink(null, link, OWNER), false);
});

test('canJoinViaLink: private room admits only accepted friends of the link creator', () => {
  const link = linkBy(OWNER, new Date(Date.now() + 60 * 1000));
  // Accepted friend of the creator: in.
  assert.equal(canJoinViaLink(privateRoom, link, FRIEND, friendRows), true);
  // Stranger: out. Pending friend request: still out.
  assert.equal(canJoinViaLink(privateRoom, link, STRANGER, []), false);
  assert.equal(canJoinViaLink(privateRoom, link, FRIEND, pendingRows), false);
  assert.equal(canJoinViaLink(privateRoom, link, FRIEND, []), false);
  // A friend of someone else in the room — but not of the creator —
  // is out: the rule is inviter ↔ invitee, like room invites.
  const friendOfMod = [{ requester: MOD, recipient: FRIEND, status: 'accepted' }];
  assert.equal(canJoinViaLink(privateRoom, link, FRIEND, friendOfMod), false);
  // Already a member: in, even with no friendship rows at all.
  assert.equal(canJoinViaLink(privateRoom, link, MEMBER, []), true);
  assert.equal(canJoinViaLink(privateRoom, link, MOD, []), true);
  // Missing room/link/user: out.
  assert.equal(canJoinViaLink(null, link, FRIEND, friendRows), false);
  assert.equal(canJoinViaLink(privateRoom, null, FRIEND, friendRows), false);
  assert.equal(canJoinViaLink(privateRoom, link, null, friendRows), false);
});

test('canJoinViaLink: public room admits anyone with the link', () => {
  const link = linkBy(OWNER, null);
  assert.equal(canJoinViaLink(publicRoom, link, STRANGER, []), true);
  assert.equal(canJoinViaLink(publicRoom, link, FRIEND, []), true);
  assert.equal(canJoinViaLink(publicRoom, link, OWNER, []), true);
});

test('InviteLink model: validates required fields offline', async () => {
  const good = new InviteLink({
    room: ROOM_ID, createdBy: OWNER, tokenHash: 'a'.repeat(64),
    token: 'iv:tag:ciphertext', expiresAt: null
  });
  await good.validate();
  const missingRoom = new InviteLink({ createdBy: OWNER, tokenHash: 'a'.repeat(64), token: 'iv:tag:ciphertext' });
  await assert.rejects(missingRoom.validate(), /room/);
  const missingHash = new InviteLink({ room: ROOM_ID, createdBy: OWNER, token: 'iv:tag:ciphertext' });
  await assert.rejects(missingHash.validate(), /tokenHash/);
  const missingToken = new InviteLink({ room: ROOM_ID, createdBy: OWNER, tokenHash: 'a'.repeat(64) });
  await assert.rejects(missingToken.validate(), /token/);
  const missingCreator = new InviteLink({ room: ROOM_ID, tokenHash: 'a'.repeat(64), token: 'iv:tag:ciphertext' });
  await assert.rejects(missingCreator.validate(), /createdBy/);
  // expiresAt is optional (null = public-room link, never expires).
  const noExpiry = new InviteLink({
    room: ROOM_ID, createdBy: OWNER, tokenHash: 'a'.repeat(64), token: 'iv:tag:ciphertext'
  });
  await noExpiry.validate();
  assert.equal(noExpiry.expiresAt, null);
});

test('InviteLink model: encrypted token round-trips (re-displayable)', () => {
  // The stored `token` field is AES-256-GCM ciphertext, not the raw
  // token — so the link can be shown again later to an authorized
  // user without invalidating the copy already shared.
  const { encrypt, decrypt } = require('../lib/crypto');
  const token = generateInviteToken();
  const stored = encrypt(token);
  assert.notEqual(stored, token);
  assert.equal(stored.includes(token), false);
  assert.equal(decrypt(stored), token);
});

test('InviteLink model: has the one-link-per-room + TTL indexes', () => {
  const indexes = InviteLink.schema.indexes().map(([fields, opts]) => ({ fields, opts }));
  const roomIdx = indexes.find((i) => i.fields.room === 1);
  assert.ok(roomIdx, 'room index exists');
  assert.equal(roomIdx.opts.unique, true, 'one active link per room');
  const hashIdx = indexes.find((i) => i.fields.tokenHash === 1);
  assert.ok(hashIdx, 'tokenHash index exists');
  assert.equal(hashIdx.opts.unique, true, 'token hashes are unique');
  const ttlIdx = indexes.find((i) => i.fields.expiresAt === 1 && i.opts.expireAfterSeconds === 0);
  assert.ok(ttlIdx, 'TTL index on expiresAt exists for storage cleanup');
});
