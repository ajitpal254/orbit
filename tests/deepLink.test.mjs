// Tests for the push deep-link hash parser (frontend/src/deepLink.js,
// ESM — run via node --test *.test.mjs). The service worker opens the
// app at these hashes when a push is tapped; App.jsx reads them on
// boot / hashchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLinkHash } from '../frontend/src/deepLink.js';

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

test('parseDeepLinkHash rejects anything it does not know', () => {
  assert.equal(parseDeepLinkHash(''), null);
  assert.equal(parseDeepLinkHash('#'), null);
  assert.equal(parseDeepLinkHash('#profile'), null);
  assert.equal(parseDeepLinkHash('#room-'), null);
  assert.equal(parseDeepLinkHash('#dm-'), null);
  assert.equal(parseDeepLinkHash('#room'), null);
  assert.equal(parseDeepLinkHash(null), null);
  assert.equal(parseDeepLinkHash(undefined), null);
});
