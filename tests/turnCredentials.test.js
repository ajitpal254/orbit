// Tests for the TURN relay URL list (lib/turnCredentials.js) and the
// audit-H2 guarantees on the /api routes.
//
// lib/turnCredentials.js used to mint credentials itself with
// HMAC-SHA1(TURN_SECRET, username); that path is gone — Metered's
// relay rejects self-minted credentials, so credentials are now minted
// via Metered's REST API in lib/meteredTurn.js (see
// tests/meteredTurn.test.js). This file keeps only what still lives
// here: the public relay URL list, and the route-level guarantees that
// no TURN username/credential ever leaks from /api/config and that
// /api/turn refuses unauthenticated callers before any credential is
// minted.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { turnUrls } = require('../lib/turnCredentials');
const apiRoutes = require('../routes/api');

const savedEnv = { TURN_URLS: process.env.TURN_URLS };
afterEach(() => {
  if (savedEnv.TURN_URLS === undefined) delete process.env.TURN_URLS;
  else process.env.TURN_URLS = savedEnv.TURN_URLS;
});

test('turnUrls: defaults to the Metered relay, honours TURN_URLS', () => {
  delete process.env.TURN_URLS;
  assert.ok(turnUrls().includes('turn:standard.relay.metered.ca:80'));
  process.env.TURN_URLS = 'turn:example.test:3478, turns:example.test:5349 ';
  assert.deepEqual(turnUrls(), ['turn:example.test:3478', 'turns:example.test:5349']);
});

test('the self-minted HMAC path is gone from lib/turnCredentials.js', () => {
  const mod = require('../lib/turnCredentials');
  assert.equal(mod.mintTurnCredentials, undefined);
  assert.equal(mod.verifyTurnCredential, undefined);
  assert.equal(mod.isTurnConfigured, undefined);
  assert.equal(mod.warnIfTurnSecretMissing, undefined);
  assert.equal(mod.turnHandler, undefined);
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
