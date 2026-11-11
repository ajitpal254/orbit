// Tests for audit H2: time-limited TURN credentials minted server-side.
//
// The static account TURN credential must never reach a client:
// GET /api/config (unauthenticated) returns no username/credential, and
// GET /api/turn mints a 24h per-user credential behind session auth.
// The minting itself is pure (lib/turnCredentials.js) and checked
// against Node's independent HMAC implementation with a placeholder
// secret — never a real credential.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const express = require('express');
const {
  TURN_TTL_SECONDS,
  turnUrls,
  isTurnConfigured,
  mintTurnCredentials,
  verifyTurnCredential,
  turnHandler
} = require('../lib/turnCredentials');
const apiRoutes = require('../routes/api');

const SECRET = 'test-only-placeholder-secret';
const USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const savedEnv = { TURN_SECRET: process.env.TURN_SECRET, TURN_URLS: process.env.TURN_URLS };
afterEach(() => {
  if (savedEnv.TURN_SECRET === undefined) delete process.env.TURN_SECRET;
  else process.env.TURN_SECRET = savedEnv.TURN_SECRET;
  if (savedEnv.TURN_URLS === undefined) delete process.env.TURN_URLS;
  else process.env.TURN_URLS = savedEnv.TURN_URLS;
});

test('mintTurnCredentials: username is <expiry>:<userId> ~24h in the future', () => {
  const now = Math.floor(Date.now() / 1000);
  const creds = mintTurnCredentials(USER_ID, SECRET, now);
  assert.equal(TURN_TTL_SECONDS, 86400);
  const [expiry, userId] = creds.username.split(':');
  assert.equal(userId, USER_ID);
  assert.ok(Number(expiry) > now + 80000 && Number(expiry) <= now + 86400);
  assert.ok(Array.isArray(creds.urls) && creds.urls.length > 0);
  assert.ok(creds.urls.every((u) => u.startsWith('turn:')));
});

test('mintTurnCredentials: credential is base64(HMAC-SHA1(secret, username))', () => {
  const creds = mintTurnCredentials(USER_ID, SECRET);
  const expected = createHmac('sha1', SECRET).update(creds.username).digest('base64');
  assert.equal(creds.credential, expected);
  // 20-byte HMAC-SHA1 -> 28 base64 chars with one '=' pad.
  assert.equal(creds.credential.length, 28);
  // A different user gets a different credential.
  const other = mintTurnCredentials('bbbbbbbbbbbbbbbbbbbbbbbb', SECRET);
  assert.notEqual(other.credential, creds.credential);
  assert.notEqual(other.username, creds.username);
});

test('verifyTurnCredential: accepts the minted credential, rejects anything else', () => {
  const creds = mintTurnCredentials(USER_ID, SECRET);
  assert.equal(verifyTurnCredential(creds.username, creds.credential, SECRET), true);
  assert.equal(verifyTurnCredential(creds.username, creds.credential, 'wrong-secret'), false);
  assert.equal(verifyTurnCredential(creds.username, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', SECRET), false);
  assert.equal(verifyTurnCredential('1:tampered', creds.credential, SECRET), false);
  assert.equal(verifyTurnCredential(creds.username, creds.credential, ''), false);
  assert.equal(verifyTurnCredential(null, creds.credential, SECRET), false);
});

test('no TURN_SECRET: mint returns null, isTurnConfigured is false', () => {
  delete process.env.TURN_SECRET;
  assert.equal(isTurnConfigured(), false);
  assert.equal(mintTurnCredentials(USER_ID), null);
  assert.equal(mintTurnCredentials(USER_ID, ''), null);
  process.env.TURN_SECRET = SECRET;
  assert.equal(isTurnConfigured(), true);
  assert.ok(mintTurnCredentials(USER_ID));
});

test('turnUrls: defaults to the Metered relay, honours TURN_URLS', () => {
  delete process.env.TURN_URLS;
  assert.ok(turnUrls().includes('turn:standard.relay.metered.ca:80'));
  process.env.TURN_URLS = 'turn:example.test:3478, turns:example.test:5349 ';
  assert.deepEqual(turnUrls(), ['turn:example.test:3478', 'turns:example.test:5349']);
});

test('turnHandler: returns the minted credential for the signed-in user', () => {
  process.env.TURN_SECRET = SECRET;
  let body;
  const res = { json: (b) => { body = b; } };
  turnHandler({ user: { _id: USER_ID } }, res);
  assert.ok(body.turn);
  assert.equal(body.turn.username.split(':')[1], USER_ID);
  assert.equal(
    body.turn.credential,
    createHmac('sha1', SECRET).update(body.turn.username).digest('base64')
  );
  assert.equal(verifyTurnCredential(body.turn.username, body.turn.credential, SECRET), true);
});

test('turnHandler: TURN_SECRET unset -> { turn: null }, still 200-shaped', () => {
  delete process.env.TURN_SECRET;
  let body;
  turnHandler({ user: { _id: USER_ID } }, { json: (b) => { body = b; } });
  assert.deepEqual(body, { turn: null });
});

// Live-router checks (no MongoDB needed: /api/config needs no auth,
// and /api/turn without a session cookie is refused before any DB call).
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const base = (server) => `http://127.0.0.1:${server.address().port}`;

test('GET /api/config (unauthenticated) returns no TURN username/credential', async () => {
  process.env.TURN_SECRET = SECRET;
  process.env.TURN_USERNAME = 'leaked-if-present';
  process.env.TURN_CREDENTIAL = 'leaked-if-present';
  const app = express();
  app.use('/api', apiRoutes);
  const server = await listen(app);
  try {
    const res = await fetch(`${base(server)}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // The URLs list stays (public), the credentials are gone — even
    // with the old env vars set, they must not leak.
    assert.ok(Array.isArray(body.turn.urls));
    assert.equal('username' in body.turn, false);
    assert.equal('credential' in body.turn, false);
    assert.equal(JSON.stringify(body).includes('leaked-if-present'), false);
  } finally {
    delete process.env.TURN_USERNAME;
    delete process.env.TURN_CREDENTIAL;
    server.close();
  }
});

test('GET /api/turn (unauthenticated) is refused before any credential is minted', async () => {
  process.env.TURN_SECRET = SECRET;
  const app = express();
  app.use('/api', apiRoutes);
  const server = await listen(app);
  try {
    const res = await fetch(`${base(server)}/api/turn`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
