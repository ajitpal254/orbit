// tests/roles.test.js — roles & moderation for private rooms (lib/roles.js).
//
// Pure logic, no Mongo: the room fixtures use the same shapes the real
// code sees — subdocument members [{ user, role }] for new rooms and
// plain ObjectId members for rooms created before roles existed. One
// wrinkle: mongoose ObjectIds are objects, so fixtures use plain
// 24-hex strings — normalizeMembers stringifies ids the same way, and
// the predicates only compare strings.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMembers, getRole, canPromote, canDemote, canKick, canMute,
  canTransfer, canLeave
} = require('../lib/roles');

const id = (n) => `00000000000000000000000${n}`;
const OWNER = id(1), MOD = id(2), MEMBER = id(3), OUTSIDER = id(4);

// A room in the new shape: members as subdocuments with roles.
const subdocRoom = (members = [
  { user: OWNER, role: 'owner' },
  { user: MOD, role: 'moderator' },
  { user: MEMBER, role: 'member' }
]) => ({ _id: id(9), createdBy: OWNER, isPrivate: true, members });

// A room in the legacy shape: plain ObjectIds, creator listed as a member.
const legacyRoom = (members = [OWNER, MEMBER]) =>
  ({ _id: id(9), createdBy: OWNER, isPrivate: true, members });

// A legacy room whose creator was never added to the member list (the
// old create path always added them, but a hand-edited or partially
// migrated room might not have them).
const legacyRoomNoCreator = () => ({ _id: id(9), createdBy: OWNER, isPrivate: true, members: [MEMBER] });

test('normalizeMembers: subdocument shape keeps roles', () => {
  assert.deepEqual(normalizeMembers(subdocRoom()), [
    { userId: OWNER, role: 'owner' },
    { userId: MOD, role: 'moderator' },
    { userId: MEMBER, role: 'member' }
  ]);
});

test('normalizeMembers: legacy plain ids become members, creator becomes owner', () => {
  assert.deepEqual(normalizeMembers(legacyRoom()), [
    { userId: OWNER, role: 'owner' },
    { userId: MEMBER, role: 'member' }
  ]);
});

test('normalizeMembers: a legacy room missing its creator gains them as owner', () => {
  assert.deepEqual(normalizeMembers(legacyRoomNoCreator()), [
    { userId: OWNER, role: 'owner' },
    { userId: MEMBER, role: 'member' }
  ]);
});

test('normalizeMembers: a subdocument that forgot the creator role is corrected', () => {
  const room = subdocRoom([
    { user: OWNER, role: 'member' },
    { user: MEMBER, role: 'member' }
  ]);
  assert.deepEqual(normalizeMembers(room), [
    { userId: OWNER, role: 'owner' },
    { userId: MEMBER, role: 'member' }
  ]);
});

test('normalizeMembers: dedupes and drops empty entries', () => {
  const room = subdocRoom([
    { user: MEMBER, role: 'member' },
    { user: MEMBER, role: 'moderator' },
    { user: null, role: 'member' },
    null,
    undefined,
    'not-an-id'
  ]);
  // The first entry for a user wins; junk is dropped; the creator is
  // added back as owner, first in the list.
  assert.deepEqual(normalizeMembers(room), [
    { userId: OWNER, role: 'owner' },
    { userId: MEMBER, role: 'member' }
  ]);
});

test('normalizeMembers: a room with no members at all still yields the owner', () => {
  assert.deepEqual(normalizeMembers({ _id: id(9), createdBy: OWNER, members: [] }), [
    { userId: OWNER, role: 'owner' }
  ]);
});

test('getRole: returns the role, or null for non-members', () => {
  const room = subdocRoom();
  assert.equal(getRole(room, OWNER), 'owner');
  assert.equal(getRole(room, MOD), 'moderator');
  assert.equal(getRole(room, MEMBER), 'member');
  assert.equal(getRole(room, OUTSIDER), null);
  // Legacy rooms resolve the same way.
  const legacy = legacyRoom();
  assert.equal(getRole(legacy, OWNER), 'owner');
  assert.equal(getRole(legacy, MEMBER), 'member');
  assert.equal(getRole(legacy, OUTSIDER), null);
});

test('canPromote: only the owner, only members', () => {
  const room = subdocRoom();
  assert.equal(canPromote(room, OWNER, MEMBER), true);
  assert.equal(canPromote(room, OWNER, MOD), false); // already a moderator
  assert.equal(canPromote(room, OWNER, OWNER), false); // cannot promote self
  assert.equal(canPromote(room, OWNER, OUTSIDER), false);
  assert.equal(canPromote(room, MOD, MEMBER), false); // moderator cannot promote
  assert.equal(canPromote(room, MEMBER, MEMBER), false);
  assert.equal(canPromote(legacyRoom(), OWNER, MEMBER), true);
});

test('canDemote: only the owner, only moderators', () => {
  const room = subdocRoom();
  assert.equal(canDemote(room, OWNER, MOD), true);
  assert.equal(canDemote(room, OWNER, MEMBER), false); // not a moderator
  assert.equal(canDemote(room, OWNER, OWNER), false);
  assert.equal(canDemote(room, MOD, MOD), false);
});

test('canKick: owner kicks anyone but self; moderator kicks members only', () => {
  const room = subdocRoom();
  assert.equal(canKick(room, OWNER, MOD), true);
  assert.equal(canKick(room, OWNER, MEMBER), true);
  assert.equal(canKick(room, OWNER, OWNER), false);
  assert.equal(canKick(room, OWNER, OUTSIDER), false);
  assert.equal(canKick(room, MOD, MEMBER), true);
  assert.equal(canKick(room, MOD, MOD), false); // cannot kick a moderator
  assert.equal(canKick(room, MOD, OWNER), false); // cannot kick the owner
  assert.equal(canKick(room, MEMBER, MEMBER), false); // plain member cannot kick
  assert.equal(canKick(legacyRoom(), OWNER, MEMBER), true);
});

test('canMute: owner or moderator, never the owner', () => {
  const room = subdocRoom();
  assert.equal(canMute(room, OWNER, MOD), true);
  assert.equal(canMute(room, OWNER, MEMBER), true);
  assert.equal(canMute(room, OWNER, OWNER), false);
  assert.equal(canMute(room, MOD, MEMBER), true);
  assert.equal(canMute(room, MOD, OWNER), false); // cannot mute the owner
  assert.equal(canMute(room, MOD, MOD), false); // cannot mute a moderator
  assert.equal(canMute(room, MEMBER, MEMBER), false); // plain member cannot mute
  assert.equal(canMute(room, OUTSIDER, MEMBER), false);
  assert.equal(canMute(legacyRoom(), OWNER, MEMBER), true);
});

test('canTransfer: only the owner, only to another member or moderator', () => {
  const room = subdocRoom();
  assert.equal(canTransfer(room, OWNER, MOD), true);
  assert.equal(canTransfer(room, OWNER, MEMBER), true);
  assert.equal(canTransfer(room, OWNER, OWNER), false); // not to self
  assert.equal(canTransfer(room, OWNER, OUTSIDER), false);
  assert.equal(canTransfer(room, MOD, MEMBER), false); // moderator cannot transfer
  assert.equal(canTransfer(legacyRoom(), OWNER, MEMBER), true);
});

test('canLeave: the owner is blocked unless they are the only member', () => {
  // Owner + others: blocked.
  assert.equal(canLeave(subdocRoom(), OWNER), false);
  assert.equal(canLeave(legacyRoom(), OWNER), false);
  // Owner alone: allowed (the room is deleted then).
  assert.equal(canLeave(subdocRoom([{ user: OWNER, role: 'owner' }]), OWNER), true);
  assert.equal(canLeave(legacyRoom([OWNER]), OWNER), true);
  // Moderators and members can always leave.
  assert.equal(canLeave(subdocRoom(), MOD), true);
  assert.equal(canLeave(subdocRoom(), MEMBER), true);
  // Non-members cannot leave either.
  assert.equal(canLeave(subdocRoom(), OUTSIDER), false);
});
