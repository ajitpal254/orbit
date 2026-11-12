// Tests for lib/meteredTurn.js — Metered REST API TURN credentials.
//
// The old design minted credentials server-side with
// HMAC-SHA1(TURN_SECRET, username); Metered's relay rejects those, so
// clients gathered only host+srflx candidates and ICE failed wherever
// the direct path fails. The server now mints ONE credential from
// Metered's REST API, caches it, refreshes it ahead of expiry, and
// serves the cached credential from GET /api/turn.
//
// Rules under test (Metered docs:
// https://www.metered.ca/docs/turn-rest-api/post-create-credential/):
// - POST https://<app>.metered.live/api/v1/turn/credential?secretKey=<key>
//   with { expiryInSeconds, label }; 200 returns { username, password,
//   expiryInSeconds, label, apiKey }.
// - A new credential takes UP TO 2 MINUTES to propagate and is not
//   usable immediately — so credentials are created ahead of time and
//   reused across calls (boot mint + refresh when <2h remains).
// - The secret key is never logged and never leaves the server except
//   to Metered's API. Tests use placeholder secrets only.
//
// Pure logic + mocked fetch — no network, no MongoDB. The clock is
// fake-controlled so refresh timing is deterministic.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  METERED_EXPIRY_SECONDS,
  REFRESH_WHEN_REMAINING_MS,
  normalizeAppDomain,
  isMeteredTurnConfigured,
  mintMeteredCredential,
  createMeteredTurn,
  warnIfMeteredTurnMissing,
  meteredTurn,
  turnHandler
} = require('../lib/meteredTurn');

const SECRET = 'test-only-placeholder-secret-key';
const DOMAIN = 'myapp.metered.live';
const USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

// Mock fetch for Metered's REST API: echoes the requested expiry, and
// hands out a fresh username/password per call so tests can tell
// generations apart. Modes: 'ok' | 'throw' | 'bad-status' | 'bad-json'
// | 'incomplete'.
const makeFetch = () => {
  const calls = [];
  let mode = 'ok';
  let counter = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    counter += 1;
    if (mode === 'throw') throw new Error('boom');
    if (mode === 'bad-status') return { ok: false, status: 401, json: async () => ({}) };
    if (mode === 'bad-json') return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
    if (mode === 'incomplete') return { ok: true, status: 200, json: async () => ({ username: 'x' }) };
    const body = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        username: `metered-user-${counter}`,
        password: `metered-pass-${counter}`,
        expiryInSeconds: body.expiryInSeconds,
        label: body.label,
        apiKey: `metered-api-key-${counter}`
      })
    };
  };
  fn.calls = calls;
  fn.setMode = (m) => { mode = m; };
  return fn;
};

const captureLog = () => {
  const calls = [];
  const log = {};
  for (const level of ['info', 'warn', 'error']) {
    // Pino accepts both log.warn(obj, msg) and log.warn(msg); keep the
    // raw args so tests can assert on either shape.
    log[level] = (...args) => { calls.push({ level, args }); };
  }
  log.calls = calls;
  return log;
};

test('normalizeAppDomain: host as-is, scheme/trailing slash/path stripped', () => {
  assert.equal(normalizeAppDomain('myapp.metered.live'), 'myapp.metered.live');
  assert.equal(normalizeAppDomain('https://myapp.metered.live/'), 'myapp.metered.live');
  assert.equal(normalizeAppDomain('http://myapp.metered.live/foo/bar'), 'myapp.metered.live');
  assert.equal(normalizeAppDomain('  myapp.metered.live  '), 'myapp.metered.live');
  assert.equal(normalizeAppDomain(''), null);
  assert.equal(normalizeAppDomain('   '), null);
  assert.equal(normalizeAppDomain(null), null);
  assert.equal(normalizeAppDomain(undefined), null);
});

test('isMeteredTurnConfigured: needs both METERED_SECRET_KEY and METERED_APP_DOMAIN', () => {
  assert.equal(isMeteredTurnConfigured({ METERED_SECRET_KEY: SECRET, METERED_APP_DOMAIN: DOMAIN }), true);
  assert.equal(isMeteredTurnConfigured({ METERED_SECRET_KEY: SECRET }), false);
  assert.equal(isMeteredTurnConfigured({ METERED_APP_DOMAIN: DOMAIN }), false);
  assert.equal(isMeteredTurnConfigured({}), false);
  assert.equal(isMeteredTurnConfigured({ METERED_SECRET_KEY: '  ', METERED_APP_DOMAIN: DOMAIN }), false);
});

test('mintMeteredCredential: posts to the Metered REST API and returns the issued credential', async () => {
  const fetchImpl = makeFetch();
  const log = captureLog();
  const minted = await mintMeteredCredential({
    secretKey: SECRET, appDomain: DOMAIN, fetchImpl, log, nowMs: 1700000000000
  });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, `https://${DOMAIN}/api/v1/turn/credential?secretKey=${encodeURIComponent(SECRET)}`);
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(opts.body), { expiryInSeconds: 86400, label: 'orbit' });
  assert.equal(minted.username, 'metered-user-1');
  assert.equal(minted.password, 'metered-pass-1');
  assert.equal(minted.expiryInSeconds, 86400);
  assert.equal(minted.mintedAtMs, 1700000000000);
});

test('mintMeteredCredential: every failure mode returns null and never logs the secret or password', async () => {
  const log = captureLog();
  for (const mode of ['throw', 'bad-status', 'bad-json', 'incomplete']) {
    const fetchImpl = makeFetch();
    fetchImpl.setMode(mode);
    const minted = await mintMeteredCredential({ secretKey: SECRET, appDomain: DOMAIN, fetchImpl, log });
    assert.equal(minted, null, `mode ${mode} must return null`);
  }
  const logged = JSON.stringify(log.calls);
  assert.equal(logged.includes(SECRET), false, 'secret key must never appear in logs');
  assert.equal(logged.includes('metered-pass'), false, 'minted password must never appear in logs');
});

test('warnIfMeteredTurnMissing: warns only when unconfigured', () => {
  const log = captureLog();
  warnIfMeteredTurnMissing(log, {});
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].level, 'warn');
  assert.match(log.calls[0].args.join(' '), /METERED_SECRET_KEY/);
  const log2 = captureLog();
  warnIfMeteredTurnMissing(log2, { METERED_SECRET_KEY: SECRET, METERED_APP_DOMAIN: DOMAIN });
  assert.equal(log2.calls.length, 0);
});

test('design constants pin the documented margins', () => {
  assert.equal(METERED_EXPIRY_SECONDS, 86400); // 24h credentials
  assert.equal(REFRESH_WHEN_REMAINING_MS, 2 * 60 * 60 * 1000); // refresh when <2h left
});

// --- cache / refresh behaviour (fake clock) ---

const makeInstance = (fetchImpl, { expirySeconds = 7200, refreshThresholdMs = 1800000 } = {}) => {
  let nowMs = 1700000000000;
  const env = { METERED_SECRET_KEY: SECRET, METERED_APP_DOMAIN: DOMAIN };
  const log = captureLog();
  const inst = createMeteredTurn({ fetchImpl, env, log, nowFn: () => nowMs, expirySeconds, refreshThresholdMs });
  return { inst, log, advance: (ms) => { nowMs += ms; }, now: () => nowMs };
};

test('getTurn: unconfigured returns null and never calls fetch', async () => {
  const fetchImpl = makeFetch();
  const inst = createMeteredTurn({ fetchImpl, env: {}, log: captureLog() });
  assert.equal(await inst.getTurn(), null);
  assert.equal(fetchImpl.calls.length, 0);
  inst.stop();
});

test('getTurn: mints once, serves the cached credential, contract matches /api/turn', async () => {
  const fetchImpl = makeFetch();
  const { inst } = makeInstance(fetchImpl);
  const first = await inst.getTurn();
  assert.deepEqual(Object.keys(first).sort(), ['credential', 'urls', 'username']);
  assert.equal(first.username, 'metered-user-1');
  assert.equal(first.credential, 'metered-pass-1');
  assert.ok(Array.isArray(first.urls) && first.urls.every((u) => u.startsWith('turn:')));
  const second = await inst.getTurn();
  assert.deepEqual(second, first, 'second call must serve the cache, not mint again');
  assert.equal(fetchImpl.calls.length, 1);
  inst.stop();
});

test('getTurn: refresh-ahead — serves the old credential while the new one is minted, then serves the new one', async () => {
  const fetchImpl = makeFetch();
  const { inst, advance } = makeInstance(fetchImpl);
  const first = await inst.getTurn(); // mint #1, expires at now + 7200s
  // Advance to <30 min remaining (threshold): 7200s - 1800s = 5400s in.
  advance(5400 * 1000 + 1);
  const during = await inst.getTurn();
  assert.equal(during.username, first.username, 'still-valid cached credential is served during refresh');
  assert.equal(fetchImpl.calls.length, 2, 'a background refresh was triggered');
  await flush();
  const after = await inst.getTurn();
  assert.equal(after.username, 'metered-user-2', 'the refreshed credential is served once minted');
  inst.stop();
});

test('getTurn: mint failure keeps serving the valid cached credential and retries on the next call', async () => {
  const fetchImpl = makeFetch();
  const { inst, advance } = makeInstance(fetchImpl);
  await inst.getTurn(); // mint #1
  fetchImpl.setMode('bad-status');
  advance(5400 * 1000 + 1); // into the refresh window
  const during = await inst.getTurn();
  assert.equal(during.username, 'metered-user-1', 'failed refresh must not drop the valid cache');
  await flush();
  const again = await inst.getTurn();
  assert.equal(again.username, 'metered-user-1');
  assert.equal(fetchImpl.calls.length, 3, 'the next call retries the refresh');
  inst.stop();
});

test('getTurn: mint failure with no cache returns null', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.setMode('throw');
  const { inst } = makeInstance(fetchImpl);
  assert.equal(await inst.getTurn(), null);
  inst.stop();
});

test('getTurn: expired cache mints synchronously and serves the fresh credential at once', async () => {
  const fetchImpl = makeFetch();
  const { inst, advance } = makeInstance(fetchImpl);
  await inst.getTurn(); // mint #1, 7200s validity
  advance(7200 * 1000 + 1); // past expiry
  const fresh = await inst.getTurn();
  assert.equal(fresh.username, 'metered-user-2', 'no 2-minute serving gate: the fresh credential is served immediately');
  inst.stop();
});

test('getTurn: concurrent calls with no cache mint only once', async () => {
  const fetchImpl = makeFetch();
  const { inst } = makeInstance(fetchImpl);
  const [a, b] = await Promise.all([inst.getTurn(), inst.getTurn()]);
  assert.equal(a.username, b.username);
  assert.equal(fetchImpl.calls.length, 1);
  inst.stop();
});

test('init: mints once at boot when configured, no-ops when not, never throws on failure', async () => {
  const fetchImpl = makeFetch();
  const { inst } = makeInstance(fetchImpl);
  await inst.init();
  assert.equal(fetchImpl.calls.length, 1);
  await inst.init(); // second init serves the cache, no second mint
  assert.equal(fetchImpl.calls.length, 1);
  inst.stop();

  const failing = makeFetch();
  failing.setMode('throw');
  const failingInst = createMeteredTurn({ fetchImpl: failing, env: { METERED_SECRET_KEY: SECRET, METERED_APP_DOMAIN: DOMAIN }, log: captureLog() });
  await failingInst.init(); // must not throw
  failingInst.stop();

  const unconfigured = createMeteredTurn({ fetchImpl: makeFetch(), env: {}, log: captureLog() });
  await unconfigured.init();
  unconfigured.stop();
});

test('reset: drops the cache so the next getTurn mints again', async () => {
  const fetchImpl = makeFetch();
  const { inst } = makeInstance(fetchImpl);
  await inst.getTurn();
  inst.reset();
  const after = await inst.getTurn();
  assert.equal(after.username, 'metered-user-2');
  assert.equal(fetchImpl.calls.length, 2);
  inst.stop();
});

// --- the shared handler (regression: never a self-minted HMAC credential) ---

const realFetch = globalThis.fetch;
const savedEnv = {
  METERED_SECRET_KEY: process.env.METERED_SECRET_KEY,
  METERED_APP_DOMAIN: process.env.METERED_APP_DOMAIN
};
afterEach(() => {
  globalThis.fetch = realFetch;
  meteredTurn.reset();
  if (savedEnv.METERED_SECRET_KEY === undefined) delete process.env.METERED_SECRET_KEY;
  else process.env.METERED_SECRET_KEY = savedEnv.METERED_SECRET_KEY;
  if (savedEnv.METERED_APP_DOMAIN === undefined) delete process.env.METERED_APP_DOMAIN;
  else process.env.METERED_APP_DOMAIN = savedEnv.METERED_APP_DOMAIN;
});

// Stub the global fetch so the singleton's mint hits Metered only;
// everything else delegates to the real fetch.
const stubMeteredFetch = () => {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('metered.live')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          username: 'metered-issued-user',
          password: 'metered-issued-pass',
          expiryInSeconds: 86400,
          label: 'orbit',
          apiKey: 'metered-issued-key'
        })
      };
    }
    return realFetch(url, opts);
  };
};

test('turnHandler: serves the Metered-issued credential, never a self-minted HMAC one', async () => {
  process.env.METERED_SECRET_KEY = SECRET;
  process.env.METERED_APP_DOMAIN = DOMAIN;
  stubMeteredFetch();
  let body;
  await turnHandler({ user: { _id: USER_ID } }, { json: (b) => { body = b; } });
  assert.equal(body.turn.username, 'metered-issued-user');
  assert.equal(body.turn.credential, 'metered-issued-pass');
  assert.ok(Array.isArray(body.turn.urls));
  // The old self-minted format was "<expiry>:<24-hex userId>" with a
  // 28-char base64 HMAC credential. Neither may ever appear again.
  assert.match(body.turn.username, /^metered-issued-user$/);
  assert.doesNotMatch(body.turn.username, /^\d+:[0-9a-f]{24}$/);
  assert.notEqual(body.turn.credential.length, 28);
  // And the old helpers are gone from the module entirely.
  const old = require('../lib/turnCredentials');
  assert.equal(old.mintTurnCredentials, undefined);
  assert.equal(old.verifyTurnCredential, undefined);

  // Second call serves the shared cache — no second mint.
  let body2;
  await turnHandler({ user: { _id: USER_ID } }, { json: (b) => { body2 = b; } });
  assert.deepEqual(body2, body);
});

test('turnHandler: unconfigured -> { turn: null }', async () => {
  delete process.env.METERED_SECRET_KEY;
  delete process.env.METERED_APP_DOMAIN;
  stubMeteredFetch();
  let body;
  await turnHandler({ user: { _id: USER_ID } }, { json: (b) => { body = b; } });
  assert.deepEqual(body, { turn: null });
});
