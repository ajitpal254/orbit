// Tests for friends + private rooms: the pure predicates in lib/friends.js,
// the isPrivate passthrough in validateRoomInput, and model validation
// (no MongoDB needed — validate() runs offline; unique indexes are only
// enforced by the database, so they are not asserted here).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  areFriends, friendshipStatus, otherUserId,
  isRoomMember, canSeeRoom, canInvite, findPendingInvite
} = require('../lib/friends');
const { validateRoomInput } = require('../lib/rooms');
const Friendship = require('../models/Friendship');
const RoomInvite = require('../models/RoomInvite');
const Room = require('../models/Room');

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const THEM = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const STRANGER = 'cccccccccccccccccccccccc';

const acceptedAB = { requester: ME, recipient: THEM, status: 'accepted' };
const acceptedBA = { requester: THEM, recipient: ME, status: 'accepted' };
const pendingAB = { requester: ME, recipient: THEM, status: 'pending' };
const pendingBA = { requester: THEM, recipient: ME, status: 'pending' };

test('areFriends: accepted in either direction, pending is not friends', () => {
  assert.equal(areFriends([acceptedAB], ME, THEM), true);
  assert.equal(areFriends([acceptedBA], ME, THEM), true);
  assert.equal(areFriends([pendingAB], ME, THEM), false);
  assert.equal(areFriends([pendingBA], ME, THEM), false);
  assert.equal(areFriends([], ME, THEM), false);
  assert.equal(areFriends([acceptedAB], ME, STRANGER), false);
});

test('friendshipStatus: none / pending-sent / pending-received / friends', () => {
  assert.equal(friendshipStatus([], ME, THEM), 'none');
  assert.equal(friendshipStatus([pendingAB], ME, THEM), 'pending-sent');
  assert.equal(friendshipStatus([pendingBA], ME, THEM), 'pending-received');
  assert.equal(friendshipStatus([acceptedAB], ME, THEM), 'friends');
  assert.equal(friendshipStatus([acceptedBA], ME, THEM), 'friends');
  // A row with someone else says nothing about me and THEM.
  assert.equal(friendshipStatus([acceptedAB], ME, STRANGER), 'none');
});

test('otherUserId returns the other party', () => {
  assert.equal(otherUserId(acceptedAB, ME), THEM);
  assert.equal(otherUserId(acceptedAB, THEM), ME);
});

const publicRoom = { isPrivate: false, members: [], createdBy: ME };
const legacyRoom = { members: [], createdBy: ME }; // no isPrivate field
const privateRoom = { isPrivate: true, members: [ME, THEM], createdBy: ME };
const privateCreatorOnly = { isPrivate: true, members: [], createdBy: ME };

test('isRoomMember: members list, and the creator always counts', () => {
  assert.equal(isRoomMember(privateRoom, ME), true);
  assert.equal(isRoomMember(privateRoom, THEM), true);
  assert.equal(isRoomMember(privateRoom, STRANGER), false);
  assert.equal(isRoomMember(privateCreatorOnly, ME), true);
  assert.equal(isRoomMember(privateCreatorOnly, STRANGER), false);
  assert.equal(isRoomMember(null, ME), false);
});

test('canSeeRoom: public and legacy rooms are open, private is members-only', () => {
  assert.equal(canSeeRoom(publicRoom, STRANGER), true);
  assert.equal(canSeeRoom(legacyRoom, STRANGER), true);
  assert.equal(canSeeRoom(privateRoom, THEM), true);
  assert.equal(canSeeRoom(privateRoom, STRANGER), false);
  assert.equal(canSeeRoom(privateCreatorOnly, ME), true);
  assert.equal(canSeeRoom(privateCreatorOnly, STRANGER), false);
  assert.equal(canSeeRoom(null, ME), false);
});

test('canInvite: member invites a friend who is not yet a member', () => {
  assert.equal(canInvite(privateRoom, ME, STRANGER, [acceptedAB]), false); // not a friend
  assert.equal(canInvite(privateRoom, ME, THEM, [acceptedAB]), false); // already a member
  assert.equal(canInvite(privateRoom, STRANGER, THEM, [acceptedAB]), false); // not a member
  const room = { isPrivate: true, members: [ME], createdBy: ME };
  assert.equal(canInvite(room, ME, THEM, [acceptedAB]), true);
  assert.equal(canInvite(room, ME, THEM, [pendingAB]), false); // pending is not friends
  assert.equal(canInvite(room, ME, THEM, [acceptedBA]), true); // either direction
});

test('findPendingInvite: only pending, only that room and invitee', () => {
  const invites = [
    { room: 'r1', invitee: THEM, status: 'pending' },
    { room: 'r1', invitee: STRANGER, status: 'pending' },
    { room: 'r2', invitee: THEM, status: 'pending' },
    { room: 'r1', invitee: THEM, status: 'accepted' }
  ];
  assert.equal(findPendingInvite(invites, 'r1', THEM).status, 'pending');
  assert.equal(findPendingInvite(invites, 'r1', STRANGER).invitee, STRANGER);
  assert.equal(findPendingInvite(invites, 'r2', STRANGER), null);
  assert.equal(findPendingInvite(invites, 'r1', 'dddddddddddddddddddddddd'), null);
  assert.equal(findPendingInvite([], 'r1', THEM), null);
});

test('validateRoomInput passes isPrivate through, defaulting to public', () => {
  assert.equal(validateRoomInput({ name: 'Secret' }).room.isPrivate, false);
  assert.equal(validateRoomInput({ name: 'Secret', isPrivate: true }).room.isPrivate, true);
  assert.equal(validateRoomInput({ name: 'Secret', isPrivate: 'yes' }).room.isPrivate, false);
  assert.equal(validateRoomInput({ name: 'Secret', isPrivate: 1 }).room.isPrivate, false);
});

test('Friendship model: required fields and status enum validate offline', async () => {
  const ok = new Friendship({ requester: ME, recipient: THEM, status: 'pending' });
  await ok.validate();
  assert.equal(ok.status, 'pending');
  const missing = new Friendship({ recipient: THEM });
  await assert.rejects(missing.validate(), /requester/);
  const badStatus = new Friendship({ requester: ME, recipient: THEM, status: 'blocked' });
  await assert.rejects(badStatus.validate(), /status/);
});

test('RoomInvite model: required fields and status enum validate offline', async () => {
  const ok = new RoomInvite({ room: 'dddddddddddddddddddddddd', inviter: ME, invitee: THEM });
  await ok.validate();
  assert.equal(ok.status, 'pending');
  const missing = new RoomInvite({ room: 'dddddddddddddddddddddddd', inviter: ME });
  await assert.rejects(missing.validate(), /invitee/);
  const badStatus = new RoomInvite({
    room: 'dddddddddddddddddddddddd', inviter: ME, invitee: THEM, status: 'ignored'
  });
  await assert.rejects(badStatus.validate(), /status/);
});

test('Room model: private fields default to public with no members', () => {
  const room = new Room({ name: 'Test', createdBy: ME });
  assert.equal(room.isPrivate, false);
  assert.deepEqual(room.members, []);
  const priv = new Room({ name: 'Secret', createdBy: ME, isPrivate: true, members: [ME] });
  assert.equal(priv.isPrivate, true);
  assert.equal(String(priv.members[0]), ME);
});
