// Tests for the push deep-link hash parser (frontend/src/deepLink.js,
// ESM — run via node --test *.test.mjs). The service worker opens the
// app at these hashes when a push is tapped; App.jsx reads them on
// boot / hashchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLinkHash, buildInviteLinkUrl } from '../frontend/src/deepLink.js';

test('parseDeepLinkHash maps plain views', () => {
  assert.deepEqual(parseDeepLinkHash('#friends'), { view: 'friends' });
  assert.deepEqual(parseDeepLinkHash('#notifications'), { view: 'notifications' });
  assert.deepEqual(parseDeepLinkHash('#messages'), { view: 'messages' });
  assert.deepEqual(parseDeepLinkHash('#rooms'), { view: 'rooms' });
  // The leading # is optional — callers pass location.hash, which has it.
  assert.deepEqual(parseDeepLinkHash('friends'), { view: 'friends' });
});

test('parseDeepLinkHash maps room and DM targets', () => {
  assert.deepEqual(
    parseDeepLinkHash('#room-68f1a2b3c4d5e6f708192a3b'),
    { view: 'rooms', roomId: '68f1a2b3c4d5e6f708192a3b' }
  );
  assert.deepEqual(
    parseDeepLinkHash('#dm-68f1a2b3c4d5e6f708192a4c'),
    { view: 'messages', dmUserId: '68f1a2b3c4d5e6f708192a4c' }
  );
});

test('parseDeepLinkHash maps invite links to a room join', () => {
  const token = 'A'.repeat(32);
  assert.deepEqual(
    parseDeepLinkHash(`#invite-${token}`),
    { view: 'rooms', inviteToken: token }
  );
  // The leading # is optional, like the other hashes.
  assert.deepEqual(
    parseDeepLinkHash(`invite-${token}`),
    { view: 'rooms', inviteToken: token }
  );
  // A malformed token still parses — the server is the authority on
  // token shape, and App shows its friendly error instead of silently
  // ignoring a link somebody shared.
  assert.deepEqual(
    parseDeepLinkHash('#invite-not-a-real-token'),
    { view: 'rooms', inviteToken: 'not-a-real-token' }
  );
});

test('parseDeepLinkHash maps email-verification links to a verify token', () => {
  const token = 'b'.repeat(64);
  assert.deepEqual(
    parseDeepLinkHash(`#verify-email-${token}`),
    { view: 'rooms', verifyEmailToken: token }
  );
  assert.deepEqual(
    parseDeepLinkHash(`verify-email-${token}`),
    { view: 'rooms', verifyEmailToken: token }
  );
  // A malformed token still parses — the verify endpoint answers 400
  // and App shows its friendly error instead of ignoring the link.
  assert.deepEqual(
    parseDeepLinkHash('#verify-email-not-a-real-token'),
    { view: 'rooms', verifyEmailToken: 'not-a-real-token' }
  );
});

test('parseDeepLinkHash rejects anything it does not know', () => {
  assert.equal(parseDeepLinkHash(''), null);
  assert.equal(parseDeepLinkHash('#'), null);
  assert.equal(parseDeepLinkHash('#profile'), null);
  assert.equal(parseDeepLinkHash('#room-'), null);
  assert.equal(parseDeepLinkHash('#dm-'), null);
  assert.equal(parseDeepLinkHash('#room'), null);
  assert.equal(parseDeepLinkHash('#invite-'), null);
  assert.equal(parseDeepLinkHash('#invite'), null);
  assert.equal(parseDeepLinkHash('#verify-email-'), null);
  assert.equal(parseDeepLinkHash('#verify-email'), null);
  assert.equal(parseDeepLinkHash(null), null);
  assert.equal(parseDeepLinkHash(undefined), null);
});

test('buildInviteLinkUrl puts the token in the hash, never the path', () => {
  const token = 'B'.repeat(32);
  assert.equal(
    buildInviteLinkUrl('https://orbit-3lzs.onrender.com', token),
    `https://orbit-3lzs.onrender.com/#invite-${token}`
  );
  // A trailing slash on the origin does not double up.
  assert.equal(
    buildInviteLinkUrl('https://example.com/', token),
    `https://example.com/#invite-${token}`
  );
  // Round trip: a built URL parses back to the same token.
  assert.deepEqual(
    parseDeepLinkHash(new URL(buildInviteLinkUrl('https://example.com', token)).hash),
    { view: 'rooms', inviteToken: token }
  );
});
