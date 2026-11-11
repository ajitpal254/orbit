// Tests for persistent notifications: the pure helpers in
// lib/notifications.js (dedup query, text, serialization) and model
// validation (no MongoDB needed — validate() runs offline).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dedupQuery, notificationText, notificationJson } = require('../lib/notifications');
const Notification = require('../models/Notification');

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ACTOR = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ROOM = 'cccccccccccccccccccccccc';

test('dedupQuery keys on (user, type, actor, room, unread)', () => {
  assert.deepEqual(
    dedupQuery({ userId: ME, type: 'dm', actorId: ACTOR, roomId: null }),
    { user: ME, type: 'dm', actor: ACTOR, room: null, read: false }
  );
  assert.deepEqual(
    dedupQuery({ userId: ME, type: 'room_invite', actorId: ACTOR, roomId: ROOM }),
    { user: ME, type: 'room_invite', actor: ACTOR, room: ROOM, read: false }
  );
  // A missing roomId normalizes to null so DMs and friend requests
  // dedup the same way regardless of how the caller passed it.
  assert.deepEqual(
    dedupQuery({ userId: ME, type: 'friend_request', actorId: ACTOR }),
    { user: ME, type: 'friend_request', actor: ACTOR, room: null, read: false }
  );
});

test('notificationText covers every type', () => {
  assert.equal(
    notificationText({ type: 'friend_request', actorName: 'Amrinder' }),
    'Amrinder sent you a friend request'
  );
  assert.equal(
    notificationText({ type: 'friend_accepted', actorName: 'Amrinder' }),
    'Amrinder accepted your friend request'
  );
  assert.equal(
    notificationText({ type: 'room_invite', actorName: 'Amrinder', roomName: 'Late Night' }),
    'Amrinder invited you to Late Night'
  );
  assert.equal(
    notificationText({ type: 'room_invite', actorName: 'Amrinder' }),
    'Amrinder invited you to a private room'
  );
  assert.equal(
    notificationText({ type: 'dm', actorName: 'Amrinder' }),
    'New message from Amrinder'
  );
  assert.equal(
    notificationText({ type: 'dm', actorName: null }),
    'New message from Someone'
  );
});

test('notificationJson shapes actor + room for the frontend', () => {
  const n = {
    _id: 'dddddddddddddddddddddddd', type: 'room_invite', read: false,
    createdAt: new Date('2026-11-11T10:00:00Z'),
    updatedAt: new Date('2026-11-11T10:05:00Z')
  };
  const actor = {
    _id: ACTOR, name: 'Amrinder', avatarPreset: 'ember', avatarImage: 'data:image/jpeg;base64,aaaa'
  };
  const room = { _id: ROOM, name: 'Late Night' };
  const j = notificationJson(n, actor, room);
  assert.equal(j.id, 'dddddddddddddddddddddddd');
  assert.equal(j.type, 'room_invite');
  assert.equal(j.text, 'Amrinder invited you to Late Night');
  assert.deepEqual(j.actor, {
    id: ACTOR, name: 'Amrinder', avatarPreset: 'ember', avatarImage: 'data:image/jpeg;base64,aaaa'
  });
  assert.deepEqual(j.room, { id: ROOM, name: 'Late Night' });
  assert.equal(j.read, false);
  // Missing actor/room degrade to null instead of crashing the list.
  const bare = notificationJson(n, null, null);
  assert.equal(bare.actor, null);
  assert.equal(bare.room, null);
  assert.equal(bare.text, 'Someone invited you to a private room');
});

test('Notification model validates type + defaults', async () => {
  const ok = new Notification({ user: ME, type: 'dm', actor: ACTOR });
  await ok.validate();
  assert.equal(ok.read, false);
  assert.equal(ok.room, null);
  const bad = new Notification({ user: ME, type: 'poke', actor: ACTOR });
  await assert.rejects(bad.validate(), /`poke` is not a valid enum value/);
  const missing = new Notification({ type: 'dm', actor: ACTOR });
  await assert.rejects(missing.validate(), /user/);
});
