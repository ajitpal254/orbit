// Tests for the v0.9.1 hardening batch (audit Lows L1–L8 + Infos
// I3/I4/I6/I8): knock re-knock rate limit, faded-room checks on
// invite paths, ObjectId validation, side-effect-free DM reads,
// log-out-everywhere, per-friend DM list caps, logger redaction,
// session TTL.
//
// DB + HTTP tests (need MongoDB): when no MongoDB is reachable they
// skip instead of failing — same pattern as
// tests/emailVerification.test.js and tests/leaveBeaconRoutes.test.js.
// The I4 (logger redact) and L5 (session TTL index) tests are pure
// and run even without MongoDB.
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { Writable } = require('node:stream');
const User = require('../models/User');
const Room = require('../models/Room');
const RoomInvite = require('../models/RoomInvite');
const InviteLink = require('../models/InviteLink');
const Knock = require('../models/Knock');
const Friendship = require('../models/Friendship');
const DirectMessage = require('../models/DirectMessage');
const Session = require('../models/Session');
const { hashPassword, newSalt, hashToken } = require('../lib/passwords');
const { encrypt } = require('../lib/crypto');
const { generateInviteToken } = require('../lib/inviteLinks');
const { createLogger } = require('../lib/logger');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit-test-hardening';
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

const post = async (path, jar, body = {}) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      'x-csrf-token': jar.csrfToken
    },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const get = async (path, jar) => {
  const res = await fetch(base + path, {
    headers: { Cookie: cookieHeader(jar) }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const befriend = (a, b) =>
  Friendship.create({ requester: a._id, recipient: b._id, status: 'accepted' });

const privateRoom = (owner, extra = {}) =>
  Room.create({
    name: 'Private Room', isPrivate: true, createdBy: owner._id,
    members: [{ user: owner._id, role: 'owner' }],
    ...extra
  });

const fadedRoom = (owner, extra = {}) =>
  privateRoom(owner, { ephemeral: true, expiresAt: new Date(Date.now() - 1000), ...extra });

// Shared identities: one login each (the login route is rate-limited
// per IP, so tests share jars and create fresh rooms/invites per test).
let alice, bob, carol, dave;
let aliceJar, bobJar, carolJar, daveJar;
let identitiesReady = false;

const setupIdentities = async () => {
  if (identitiesReady) return;
  identitiesReady = true;
  alice = await makeUser('alice-hardening@example.com', 'Alice');
  bob = await makeUser('bob-hardening@example.com', 'Bob');
  carol = await makeUser('carol-hardening@example.com', 'Carol');
  dave = await makeUser('dave-hardening@example.com', 'Dave');
  aliceJar = await login('alice-hardening@example.com');
  bobJar = await login('bob-hardening@example.com');
  carolJar = await login('carol-hardening@example.com');
  daveJar = await login('dave-hardening@example.com');
  await befriend(alice, bob);
  await befriend(alice, carol);
  await befriend(alice, dave);
  await befriend(bob, carol);
};

// --- L2: knock re-knock after a decline is rate-limited on updatedAt ---

test('L2: re-knock right after a decline is 429; after the 30s window it reopens', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setupIdentities();
  const room = await privateRoom(alice);
  const first = await post(`/api/rooms/${room._id}/knock`, bobJar);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const knockId = first.body.id;
  const declined = await post(`/api/knocks/${knockId}/decline`, aliceJar);
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  // Immediate re-knock: the decline restarted the 30s window.
  const tooSoon = await post(`/api/rooms/${room._id}/knock`, bobJar);
  assert.equal(tooSoon.status, 429, JSON.stringify(tooSoon.body));
  // Age the last knock event past the window (raw update: Mongoose
  // would bump updatedAt itself, so timestamps are disabled here).
  await Knock.updateOne(
    { _id: knockId },
    { $set: { updatedAt: new Date(Date.now() - 31 * 1000) } },
    { timestamps: false }
  );
  const again = await post(`/api/rooms/${room._id}/knock`, bobJar);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.status, 'pending');
});

// --- L3: faded-room (410) checks on invite paths ---

test('L3: accepting an invite to a faded campfire is 410, and the stale invite is dropped', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setupIdentities();
  const room = await fadedRoom(alice);
  const invite = await RoomInvite.create({
    room: room._id, inviter: alice._id, invitee: bob._id, status: 'pending'
  });
  const res = await post(`/api/invites/${invite._id}/accept`, bobJar);
  assert.equal(res.status, 410, JSON.stringify(res.body));
  assert.match(res.body.error, /faded/i);
  assert.equal(await RoomInvite.findById(invite._id), null, 'stale invite is dropped');
});

test('L3: joining via invite link on a faded campfire is 410', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setupIdentities();
  const room = await fadedRoom(alice);
  const token = generateInviteToken();
  await InviteLink.create({
    room: room._id, createdBy: alice._id,
    tokenHash: hashToken(token), token: encrypt(token),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  });
  const res = await post('/api/invite-links/join', carolJar, { token });
  assert.equal(res.status, 410, JSON.stringify(res.body));
  assert.match(res.body.error, /faded/i);
});

test('L3: sending an invite to a faded campfire is 410', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setupIdentities();
  const room = await fadedRoom(alice);
  const res = await post(`/api/rooms/${room._id}/invite`, aliceJar, { userId: String(bob._id) });
  assert.equal(res.status, 410, JSON.stringify(res.body));
  assert.match(res.body.error, /faded/i);
});

// --- L7: malformed ObjectIds answer 400, never 500 ---

test('L7: malformed ids return 400 on room, invite, and notification routes', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setupIdentities();
  const bad = 'not-an-object-id';
  const cases = [
    await get(`/api/rooms/${bad}`, aliceJar),
    await post(`/api/rooms/${bad}/join`, aliceJar),
    await post(`/api/rooms/${bad}/mode`, aliceJar),
    await post(`/api/invites/${bad}/accept`, aliceJar),
    await post(`/api/invites/${bad}/decline`, aliceJar),
    await post(`/api/notifications/${bad}/read`, aliceJar),
    await post(`/api/rooms/${bad}/knock`, aliceJar)
  ];
  for (const res of cases) {
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
});

// --- L8: GET thread is side-effect-free; POST read marks read ---

test('L8: opening a DM thread (GET) does not mark messages read; POST /read does', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setupIdentities();
  const dm = await DirectMessage.create({
    sender: bob._id, recipient: alice._id, text: encrypt('hey alice'), read: false
  });
  const thread = await get(`/api/dms/${bob._id}`, aliceJar);
  assert.equal(thread.status, 200, JSON.stringify(thread.body));
  assert.equal(thread.body[0].read, false, 'GET must not flip read');
  assert.equal((await DirectMessage.findById(dm._id)).read, false, 'row still unread in the DB');
  const marked = await post(`/api/dms/${bob._id}/read`, aliceJar);
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  assert.equal(marked.body.read, 1);
  assert.equal((await DirectMessage.findById(dm._id)).read, true);
  const again = await get(`/api/dms/${bob._id}`, aliceJar);
  assert.equal(again.body[0].read, true);
});

// --- I3: log out of all devices ---

test('I3: logout-all deletes every session; the other session then 401s', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setupIdentities();
  const jar2 = await login('alice-hardening@example.com');
  assert.equal(await Session.countDocuments({ userId: alice._id }), 2);
  const res = await post('/api/auth/logout-all', aliceJar);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await Session.countDocuments({ userId: alice._id }), 0);
  const me = await get('/api/auth/me', jar2);
  assert.equal(me.status, 401, 'the second session is dead too');
  // Re-login so later tests (shared jars) keep working.
  const fresh = await login('alice-hardening@example.com');
  Object.assign(aliceJar, fresh);
});

test('I3: logout-all without a session is 401', async (t) => {
  if (skipIfNoMongo(t)) return;
  // A valid CSRF token but no session: CSRF passes, auth refuses.
  // (With no CSRF token at all the answer is 403 from the CSRF
  // middleware — that runs before auth — which is also correct.)
  const jar = {};
  const csrf = await fetch(base + '/api/auth/csrf-token', { headers: {} });
  parseSetCookies(csrf, jar);
  jar.csrfToken = (await csrf.json()).csrfToken;
  const res = await post('/api/auth/logout-all', jar);
  assert.equal(res.status, 401);
});

// --- I8: DM list is capped per friend, not one global 1,000-row fetch ---

test('I8: a heavy thread cannot crowd other friends out of the DM list', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setupIdentities();
  const baseTime = Date.now();
  // Dave's one message is OLDER than all of Carol's 1,005 — under the
  // old global limit(1000) newest-first fetch it would fall off the
  // list entirely (Dave's lastMessage would read null). Dave is used
  // (not Bob) because the L8 test above already left Bob a DM.
  const heavy = [];
  for (let i = 0; i < 1005; i++) {
    heavy.push({
      sender: carol._id, recipient: alice._id,
      text: encrypt(`carol msg ${i}`), read: i % 2 === 0,
      createdAt: new Date(baseTime - 1000 * 1000 + i * 1000)
    });
  }
  await DirectMessage.insertMany(heavy);
  await DirectMessage.create({
    sender: dave._id, recipient: alice._id,
    text: encrypt('dave old message'), read: false,
    createdAt: new Date(baseTime - 2 * 1000 * 1000)
  });
  const list = await get('/api/dms', aliceJar);
  assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 200));
  const byName = new Map(list.body.map((s) => [s.name, s]));
  const carolSummary = byName.get('Carol');
  const daveSummary = byName.get('Dave');
  assert.ok(carolSummary, 'Carol is listed');
  assert.ok(daveSummary, 'Dave is listed');
  assert.equal(carolSummary.lastMessage.text, 'carol msg 1004');
  assert.equal(carolSummary.unreadCount, 502, 'only Carol\'s unread are counted for Carol');
  assert.equal(daveSummary.lastMessage.text, 'dave old message', 'Dave survives the heavy thread');
  assert.equal(daveSummary.unreadCount, 1);
});

// --- I4: pino redact covers token fields (pure — runs without MongoDB) ---

test('I4: logger redacts credential / sessionToken / csrfToken / token values', async () => {
  let out = '';
  const stream = new Writable({
    write(chunk, _enc, cb) { out += chunk.toString(); cb(); }
  });
  const log = createLogger(stream);
  log.info({
    credential: 'SECRET-CREDENTIAL',
    sessionToken: 'SECRET-SESSION',
    csrfToken: 'SECRET-CSRF',
    token: 'SECRET-TOKEN',
    nested: { token: 'SECRET-NESTED' },
    password: 'SECRET-PASSWORD'
  }, 'redact check');
  await new Promise((r) => setImmediate(r));
  for (const secret of ['SECRET-CREDENTIAL', 'SECRET-SESSION', 'SECRET-CSRF', 'SECRET-TOKEN', 'SECRET-NESTED', 'SECRET-PASSWORD']) {
    assert.ok(!out.includes(secret), `${secret} must not appear in logs`);
  }
  assert.ok(out.includes('[REDACTED]'), 'redacted values are replaced');
});

// --- L5: session TTL index (pure schema check — runs without MongoDB) ---

test('L5: Session.expiresAt carries a TTL index (expireAfterSeconds 0)', () => {
  const indexes = Session.schema.indexes();
  const ttl = indexes.find(([, opts]) => opts && opts.expireAfterSeconds === 0);
  assert.ok(ttl, `expected a TTL index, got ${JSON.stringify(indexes)}`);
  assert.deepEqual(ttl[0], { expiresAt: 1 });
});
