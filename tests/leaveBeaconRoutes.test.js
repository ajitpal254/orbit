// Tests for the leave-beacon route (v0.9.0): POST
// /api/rooms/:id/leave-beacon — the pagehide beacon a tab sends when
// it really closes, so the room sees the departure at once instead
// of after the 15s disconnect grace.
//
// The beacon is the one POST exempt from the double-submit CSRF
// header (navigator.sendBeacon cannot set custom headers); these
// tests send it exactly as the browser does — session cookie, NO
// x-csrf-token — and prove it still lands. Auth is still enforced
// (401 without a session).
//
// DB + HTTP tests (need MongoDB): when no MongoDB is reachable they
// skip instead of failing — same pattern as
// tests/emailVerification.test.js and tests/mediaRoutes.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const { hashPassword, newSalt } = require('../lib/passwords');
const presence = require('../lib/presence');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit-test-beacon';
let mongoAvailable = false;
let server = null;
let base = '';

const skipIfNoMongo = (t) => {
  if (!mongoAvailable) {
    t.skip('no MongoDB reachable at ' + MONGO_URI);
    return true;
  }
  return false;
};

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    mongoAvailable = true;
    await mongoose.connection.db.dropDatabase();
    const { app } = require('../server');
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoAvailable) {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
});

const parseSetCookies = (res, jar) => {
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
};

const cookieHeader = (jar) =>
  Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

const PW = 'correct-horse-battery-staple-1';

const makeUser = async (email, name) => {
  const salt = newSalt();
  return User.create({
    email, name, emailVerified: true,
    passwordSalt: salt, passwordHash: hashPassword(PW, salt)
  });
};

const login = async (email) => {
  const jar = {};
  const csrf = await fetch(base + '/api/auth/csrf-token', { headers: {} });
  parseSetCookies(csrf, jar);
  const csrfBody = await csrf.json();
  jar.csrfToken = csrfBody.csrfToken;
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar), 'x-csrf-token': jar.csrfToken },
    body: JSON.stringify({ email, password: PW })
  });
  parseSetCookies(res, jar);
  assert.equal(res.status, 200, `login for ${email} should succeed`);
  return jar;
};

// The beacon, exactly as the browser sends it: session cookie, no
// x-csrf-token header, no body. (The route must never 500 on a dying
// tab's best-effort send, so a missing body is fine.)
const beacon = async (roomId, jar = {}) => {
  const res = await fetch(base + `/api/rooms/${roomId}/leave-beacon`, {
    method: 'POST',
    headers: { ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}) }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let alice, aliceJar;
const ROOM_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const setup = async () => {
  alice = await makeUser('alice-beacon@example.com', 'Alice');
  aliceJar = await login('alice-beacon@example.com');
  // Presence only: the beacon route never reads the Room doc (a
  // beacon for a deleted room is a no-op, never a 500).
  presence.clearAll();
  presence.addOccupant(ROOM_ID, 'sock-alice', { id: String(alice._id), name: 'Alice' });
};

test('beacon without a CSRF header departs at once and is idempotent', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setup();
  const first = await beacon(ROOM_ID, aliceJar);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { ok: true, departed: true });
  assert.equal(presence.occupancyCount(ROOM_ID), 0, 'presence is gone immediately, no grace');
  const second = await beacon(ROOM_ID, aliceJar);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { ok: true, departed: false }, 'second beacon is a no-op');
});

test('beacon without a session is 401 (auth still enforced)', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setup();
  const res = await beacon(ROOM_ID);
  assert.equal(res.status, 401);
  assert.equal(presence.occupancyCount(ROOM_ID), 1, 'nobody departed');
});

test('beacon for a room I am not in is a 200 no-op, never a 500', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setup();
  const res = await beacon('bbbbbbbbbbbbbbbbbbbbbbbb', aliceJar);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, departed: false });
});
