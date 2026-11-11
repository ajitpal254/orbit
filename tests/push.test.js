// Tests for web push helpers (lib/push.js): the pure payload builder
// and the VAPID configuration check. Actual sending needs a push
// service and is not exercised here — sendPushToUser is best-effort
// and never throws, so the routes cannot be broken by it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pushPayloadFor, isPushConfigured, getVapidPublicKey } = require('../lib/push');

test('pushPayloadFor covers every notification type', () => {
  assert.deepEqual(
    pushPayloadFor({ type: 'friend_request', actorName: 'Amrinder' }),
    { title: 'Orbit', body: 'Amrinder sent you a friend request', tag: 'orbit-friend_request', data: { url: '/#friends' } }
  );
  assert.deepEqual(
    pushPayloadFor({ type: 'friend_accepted', actorName: 'Amrinder' }),
    { title: 'Orbit', body: 'Amrinder accepted your friend request', tag: 'orbit-friend_accepted', data: { url: '/#friends' } }
  );
  assert.deepEqual(
    pushPayloadFor({ type: 'room_invite', actorName: 'Amrinder', roomId: '68f1a2b3c4d5e6f708192a3b', roomName: 'Late Night' }),
    { title: 'Orbit', body: 'Amrinder invited you to Late Night', tag: 'orbit-room_invite', data: { url: '/#room-68f1a2b3c4d5e6f708192a3b' } }
  );
  assert.deepEqual(
    pushPayloadFor({ type: 'knock', actorName: 'Amrinder', roomId: '68f1a2b3c4d5e6f708192a3b', roomName: 'Late Night' }),
    { title: 'Orbit', body: 'Amrinder knocked on Late Night', tag: 'orbit-knock', data: { url: '/#room-68f1a2b3c4d5e6f708192a3b' } }
  );
  assert.deepEqual(
    pushPayloadFor({ type: 'dm', actorName: 'Amrinder', actorId: '68f1a2b3c4d5e6f708192a4c' }),
    { title: 'Orbit', body: 'New message from Amrinder', tag: 'orbit-dm', data: { url: '/#dm-68f1a2b3c4d5e6f708192a4c' } }
  );
  assert.deepEqual(
    pushPayloadFor({ type: 'test', actorName: 'Amrinder' }),
    { title: 'Orbit', body: 'This is a test notification — push is working.', tag: 'orbit-test', data: { url: '/#notifications' } }
  );
  // Unknown types and missing names degrade to a generic push, never
  // a crash — the in-app text is the source of truth anyway.
  assert.equal(pushPayloadFor({ type: 'weird', actorName: null }).body, 'Something happened on Orbit');
});

test('pushPayloadFor deep links fall back to the list when ids are missing', () => {
  // An invite recorded without a room id (or a DM without an actor id)
  // must still open somewhere sensible — the rooms / messages list —
  // instead of a broken `#room-undefined` link.
  assert.equal(
    pushPayloadFor({ type: 'room_invite', actorName: 'Amrinder', roomName: 'Late Night' }).data.url,
    '/#rooms'
  );
  assert.equal(
    pushPayloadFor({ type: 'knock', actorName: 'Amrinder', roomName: 'Late Night' }).data.url,
    '/#rooms'
  );
  assert.equal(
    pushPayloadFor({ type: 'dm', actorName: 'Amrinder' }).data.url,
    '/#messages'
  );
  assert.equal(pushPayloadFor({ type: 'weird' }).data.url, '/');
});

test('isPushConfigured needs both VAPID keys in env', () => {
  const savedPub = process.env.VAPID_PUBLIC_KEY;
  const savedPriv = process.env.VAPID_PRIVATE_KEY;
  try {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    assert.equal(isPushConfigured(), false);
    assert.equal(getVapidPublicKey(), null);
    process.env.VAPID_PUBLIC_KEY = 'public';
    assert.equal(isPushConfigured(), false);
    process.env.VAPID_PRIVATE_KEY = 'private';
    assert.equal(isPushConfigured(), true);
    assert.equal(getVapidPublicKey(), 'public');
  } finally {
    if (savedPub === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = savedPub;
    if (savedPriv === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = savedPriv;
  }
});
