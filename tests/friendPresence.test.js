// Tests for the desktop 3-zone friends presence: the pure mapper in
// lib/friendPresence.js (statuses + sort order) and the new presence
// registry helpers it is built on (lib/presence.js snapshot/roomOfUser,
// lib/socket.js onlineUserIds). No MongoDB needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFriendPresence } = require('../lib/friendPresence');
const presence = require('../lib/presence');
const { registerUserSocket, unregisterUserSocket, onlineUserIds } = require('../lib/socket');

const FRIENDS = [
  { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Zoe', email: 'zoe@example.com', avatarPreset: 'nova', avatarImage: '' },
  { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Amy', email: 'amy@example.com', avatarPreset: null, avatarImage: '' },
  { id: 'cccccccccccccccccccccccc', name: 'Max', email: 'max@example.com', avatarPreset: null, avatarImage: '' },
  { id: 'dddddddddddddddddddddddd', name: 'Kim', email: 'kim@example.com', avatarPreset: null, avatarImage: '' }
];

test('buildFriendPresence: in-room / online / away from the registries', () => {
  const online = new Set(['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb']);
  const roomByUser = new Map([
    ['aaaaaaaaaaaaaaaaaaaaaaaa', { id: 'room1', name: 'Late Night' }]
  ]);
  const rows = buildFriendPresence(FRIENDS, online, roomByUser);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.aaaaaaaaaaaaaaaaaaaaaaaa.status, 'in-room');
  assert.deepEqual(byId.aaaaaaaaaaaaaaaaaaaaaaaa.room, { id: 'room1', name: 'Late Night' });
  assert.equal(byId.bbbbbbbbbbbbbbbbbbbbbbbb.status, 'online');
  assert.equal(byId.bbbbbbbbbbbbbbbbbbbbbbbb.room, null);
  assert.equal(byId.cccccccccccccccccccccccc.status, 'away');
  assert.equal(byId.dddddddddddddddddddddddd.status, 'away');
});

test('buildFriendPresence: sorted in-room, then online, then away; name within each group', () => {
  const online = new Set([
    'aaaaaaaaaaaaaaaaaaaaaaaa', // Zoe — in-room
    'bbbbbbbbbbbbbbbbbbbbbbbb', // Amy — online
    'dddddddddddddddddddddddd' // Kim — online
  ]);
  const roomByUser = new Map([
    ['aaaaaaaaaaaaaaaaaaaaaaaa', { id: 'room1', name: 'Late Night' }],
    ['cccccccccccccccccccccccc', { id: 'room1', name: 'Late Night' }] // Max — in-room, not "online"
  ]);
  const rows = buildFriendPresence(FRIENDS, online, roomByUser);
  assert.deepEqual(rows.map((r) => r.name), ['Max', 'Zoe', 'Amy', 'Kim']);
  assert.deepEqual(rows.map((r) => r.status), ['in-room', 'in-room', 'online', 'online']);
});

test('buildFriendPresence: a friend in a room counts as in-room even without a socket entry', () => {
  // Presence is the source of truth for room membership; the socket
  // registry only decides online-vs-away for everyone else.
  const rows = buildFriendPresence(
    [FRIENDS[0]],
    new Set(),
    new Map([['aaaaaaaaaaaaaaaaaaaaaaaa', { id: 'r1', name: 'Room' }]])
  );
  assert.equal(rows[0].status, 'in-room');
});

test('buildFriendPresence: empty and null inputs give an empty list', () => {
  assert.deepEqual(buildFriendPresence([], new Set(), new Map()), []);
  assert.deepEqual(buildFriendPresence(null, null, null), []);
  // Plain arrays / objects work too, not just Set / Map.
  const rows = buildFriendPresence(
    [FRIENDS[1]],
    ['bbbbbbbbbbbbbbbbbbbbbbbb'],
    { bbbbbbbbbbbbbbbbbbbbbbbb: { id: 'r1', name: 'Room' } }
  );
  assert.equal(rows[0].status, 'in-room');
});

test('presence.snapshot + roomOfUser: which room each user is in', () => {
  presence.clearAll();
  const userA = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Amy' };
  const userB = { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Max' };
  presence.addOccupant('room1', 'sock-a', userA);
  presence.addOccupant('room1', 'sock-b', userB);
  presence.addOccupant('room2', 'sock-c', userA);
  assert.equal(presence.roomOfUser('aaaaaaaaaaaaaaaaaaaaaaaa'), 'room1');
  assert.equal(presence.roomOfUser('bbbbbbbbbbbbbbbbbbbbbbbb'), 'room1');
  assert.equal(presence.roomOfUser('cccccccccccccccccccccccc'), null);
  const snap = presence.snapshot();
  assert.equal(snap.length, 2);
  const r1 = snap.find((s) => s.roomId === 'room1');
  assert.equal(r1.occupants.length, 2);
  assert.deepEqual(
    r1.occupants.map((o) => o.userId).sort(),
    ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb']
  );
  presence.removeSocketEverywhere('sock-a');
  assert.equal(presence.roomOfUser('aaaaaaaaaaaaaaaaaaaaaaaa'), 'room2');
  presence.clearAll();
  assert.deepEqual(presence.snapshot(), []);
});

test('socket.onlineUserIds tracks live sockets per user', () => {
  registerUserSocket('aaaaaaaaaaaaaaaaaaaaaaaa', 'sock-1');
  registerUserSocket('aaaaaaaaaaaaaaaaaaaaaaaa', 'sock-2');
  registerUserSocket('bbbbbbbbbbbbbbbbbbbbbbbb', 'sock-3');
  assert.deepEqual(
    [...onlineUserIds()].sort(),
    ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb']
  );
  unregisterUserSocket('aaaaaaaaaaaaaaaaaaaaaaaa', 'sock-1');
  assert.equal(onlineUserIds().has('aaaaaaaaaaaaaaaaaaaaaaaa'), true);
  unregisterUserSocket('aaaaaaaaaaaaaaaaaaaaaaaa', 'sock-2');
  assert.equal(onlineUserIds().has('aaaaaaaaaaaaaaaaaaaaaaaa'), false);
  assert.equal(onlineUserIds().has('bbbbbbbbbbbbbbbbbbbbbbbb'), true);
  unregisterUserSocket('bbbbbbbbbbbbbbbbbbbbbbbb', 'sock-3');
  assert.equal(onlineUserIds().size, 0);
});
