// Tests for the Google sign-in gate (frontend/src/googleSignIn.js).
// This is the logic Auth.jsx uses to decide whether the Google button
// appears at all: no client ID configured -> no button, password login
// keeps working untouched. The module touches no DOM at import time, so it
// runs in plain Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGoogleClientId, shouldShowGoogleButton } from '../frontend/src/googleSignIn.js';

test('no client ID in config -> null (no Google button)', () => {
  assert.equal(getGoogleClientId({}), null);
  assert.equal(getGoogleClientId({ googleClientId: null }), null);
  assert.equal(getGoogleClientId({ googleClientId: '' }), null);
  assert.equal(getGoogleClientId({ googleClientId: '   ' }), null);
  assert.equal(getGoogleClientId(null), null);
  assert.equal(getGoogleClientId(undefined), null);
});

test('client ID present -> returned trimmed', () => {
  assert.equal(
    getGoogleClientId({ googleClientId: '  123-abc.apps.googleusercontent.com  ' }),
    '123-abc.apps.googleusercontent.com'
  );
});

test('shouldShowGoogleButton is false without a client ID, true with one', () => {
  assert.equal(shouldShowGoogleButton(null), false);
  assert.equal(shouldShowGoogleButton(''), false);
  assert.equal(shouldShowGoogleButton(undefined), false);
  assert.equal(shouldShowGoogleButton('123-abc.apps.googleusercontent.com'), true);
});
