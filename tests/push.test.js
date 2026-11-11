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
    { title: 'Orbit', body: 'Amrinder sent you a friend request', tag: 'orbit-friend_request' }
  );
  assert.deepEqual(
    pushPayloadFor({ type: 'friend_accepted', actorName: 'Amrinder' }),
    { title: 'Orbit', body: 'Amrinder accepted your friend request', tag: 'orbit-friend_accepted' }
  );
  assert.deepEqual(
    pushPayloadFor({ type: 'room_invite', actorName: 'Amrinder', roomName: 'Late Night' }),
    { title: 'Orbit', body: 'Amrinder invited you to Late Night', tag: 'orbit-room_invite' }
  );
  assert.deepEqual(
    pushPayloadFor({ type: 'dm', actorName: 'Amrinder' }),
    { title: 'Orbit', body: 'New message from Amrinder', tag: 'orbit-dm' }
  );
  // Unknown types and missing names degrade to a generic push, never
  // a crash — the in-app text is the source of truth anyway.
  assert.equal(pushPayloadFor({ type: 'weird', actorName: null }).body, 'Something happened on Orbit');
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
