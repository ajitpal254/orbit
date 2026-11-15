// Tests for POST /api/music/youtube (v0.10.0): resolve a YouTube
// link to a direct audio stream URL.
//
// DB + HTTP tests (need MongoDB): when no MongoDB is reachable they
// skip instead of failing — same pattern as
// tests/leaveBeaconRoutes.test.js. The resolver itself is stubbed
// (routes/api.js imports lib/youtube as a namespace, so the test
// replaces youtube.resolveYouTubeAudio and restores it) — no test
// ever calls the real yt-dlp binary or YouTube.
//
// CSRF: the route is a normal POST behind the global csrfMiddleware,
// so every call carries the session cookie + x-csrf-token, exactly
// like the browser.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const Room = require('../models/Room');
const { hashPassword, newSalt } = require('../lib/passwords');
const youtube = require('../lib/youtube');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit-test-music-routes';
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
    // One shared setup for the whole file: every test logs in
    // through the same two accounts, because the login route itself
    // is rate-limited to 10 per 15 min per IP — a fresh login per
    // test would trip it before the music-route tests even run.
    await setup();
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

const resolve = async (jar, body) => {
  const res = await fetch(base + '/api/music/youtube', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(jar ? { Cookie: cookieHeader(jar), 'x-csrf-token': jar.csrfToken } : {})
    },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// A CSRF token with no session: the global csrfMiddleware passes
// (cookie + header match) and authMiddleware answers the 401. A
// bare POST with no token at all would 403 in csrfMiddleware first.
const csrfOnlyJar = async () => {
  const jar = {};
  const csrf = await fetch(base + '/api/auth/csrf-token', { headers: {} });
  parseSetCookies(csrf, jar);
  jar.csrfToken = (await csrf.json()).csrfToken;
  return jar;
};

let alice, bob, aliceJar, bobJar, publicRoom, privateRoom;
const setup = async () => {
  alice = await makeUser('alice-music@example.com', 'Alice');
  bob = await makeUser('bob-music@example.com', 'Bob');
  aliceJar = await login('alice-music@example.com');
  bobJar = await login('bob-music@example.com');
  publicRoom = await Room.create({ name: 'Public Room', createdBy: alice._id });
  privateRoom = await Room.create({
    name: 'Private Room', isPrivate: true,
    members: [{ user: alice._id, role: 'owner' }],
    createdBy: alice._id
  });
};

const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const GOOD_AUDIO_URL = 'https://rr2---sn-p5qlsnd6.googlevideo.com/videoplayback?expire=1&sig=abc';

// Stub the resolver for one test, restoring it afterwards even on failure.
const withStubbedResolver = async (impl, fn) => {
  const original = youtube.resolveYouTubeAudio;
  youtube.resolveYouTubeAudio = impl;
  try {
    await fn();
  } finally {
    youtube.resolveYouTubeAudio = original;
  }
};

test('resolving without a session is 401', async (t) => {
  if (skipIfNoMongo(t)) return;
  const jar = await csrfOnlyJar();
  const res = await resolve(jar, { url: YT_URL, roomId: String(publicRoom._id) });
  assert.equal(res.status, 401);
});

test('a non-YouTube URL is 400 INVALID_URL (the resolver never runs)', async (t) => {
  if (skipIfNoMongo(t)) return;

  let ran = false;
  await withStubbedResolver(async () => { ran = true; return {}; }, async () => {
    const res = await resolve(aliceJar, { url: 'https://example.com/video.mp4', roomId: String(publicRoom._id) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'INVALID_URL');
  });
  assert.equal(ran, false, 'the resolver must not run for a non-YouTube URL');
});

test('a missing URL is 400 INVALID_URL', async (t) => {
  if (skipIfNoMongo(t)) return;

  const res = await resolve(aliceJar, { roomId: String(publicRoom._id) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_URL');
});

test('a room the caller cannot see is 403 (private room, non-member)', async (t) => {
  if (skipIfNoMongo(t)) return;

  const res = await resolve(bobJar, { url: YT_URL, roomId: String(privateRoom._id) });
  assert.equal(res.status, 403);
});

test('an invalid or missing room is 403', async (t) => {
  if (skipIfNoMongo(t)) return;

  const badId = await resolve(aliceJar, { url: YT_URL, roomId: 'not-an-id' });
  assert.equal(badId.status, 403);
  const gone = await resolve(aliceJar, { url: YT_URL, roomId: 'cccccccccccccccccccccccc' });
  assert.equal(gone.status, 403);
});

test('a resolver failure is 502 YOUTUBE_UNAVAILABLE, never a 500', async (t) => {
  if (skipIfNoMongo(t)) return;

  await withStubbedResolver(async () => {
    const err = new Error('YouTube audio unavailable: timeout');
    err.code = 'YOUTUBE_UNAVAILABLE';
    throw err;
  }, async () => {
    const res = await resolve(aliceJar, { url: YT_URL, roomId: String(publicRoom._id) });
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'YOUTUBE_UNAVAILABLE');
  });
});

test('a stubbed success returns 200 with audioUrl + title + duration', async (t) => {
  if (skipIfNoMongo(t)) return;

  await withStubbedResolver(async () => ({
    audioUrl: GOOD_AUDIO_URL, title: 'Test Song', duration: 213
  }), async () => {
    const res = await resolve(aliceJar, { url: YT_URL, roomId: String(publicRoom._id) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { audioUrl: GOOD_AUDIO_URL, title: 'Test Song', duration: 213 });
  });
});

test('the rate limit trips after the cap (10 per 15 min per IP)', async (t) => {
  if (skipIfNoMongo(t)) return;

  // Earlier tests in this file already spent part of the per-IP
  // bucket, so fire until the 429 lands instead of assuming an
  // exact remaining count. The global /api limiter (120/min) is far
  // above this file's total request count, so a 429 here is the
  // music-route limiter.
  await withStubbedResolver(async () => ({
    audioUrl: GOOD_AUDIO_URL, title: 'Test Song', duration: 213
  }), async () => {
    let saw429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await resolve(aliceJar, { url: YT_URL, roomId: String(publicRoom._id) });
      if (res.status === 429) { saw429 = true; break; }
      assert.equal(res.status, 200, `attempt ${i} should succeed or 429, got ${res.status}`);
    }
    assert.equal(saw429, true, 'the rate limit never tripped');
  });
});
