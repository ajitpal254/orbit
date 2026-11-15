// Tests for linking a Google account from Settings (v0.9.1).
//
// Two layers:
//   - Lib tests (need MongoDB): linkGoogleAccount — success, the
//     idempotent already-linked case, email mismatch, a Google id
//     owned by someone else, and a user already linked to a different
//     Google account.
//   - DB + HTTP tests (need MongoDB): POST /api/auth/google/link
//     against the real Express app with the Google verifier stubbed
//     (the route calls googleAuth.verifyGoogleCredential through the
//     module namespace, so tests can replace it with a fake — no real
//     Google account needed), plus the /auth/google 409 guard at
//     route level (audit M1) and the 503 when Google is unconfigured.
//   When no MongoDB is reachable they skip instead of failing — the
//   suite has no Mongo in CI (see tests/rooms.test.js). Run a local
//   mongod (or set MONGODB_URI) to exercise them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const { hashPassword, newSalt } = require('../lib/passwords');
const googleAuth = require('../lib/googleAuth');
const { linkGoogleAccount } = googleAuth;

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit-test-google-link';
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

const realVerify = googleAuth.verifyGoogleCredential;

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    mongoAvailable = true;
    await mongoose.connection.db.dropDatabase();
    // The link route 503s without a client ID; the tests stub the
    // verifier itself, so any non-empty value works here.
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
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
  googleAuth.verifyGoogleCredential = realVerify;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoAvailable) {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
});

// --- Minimal cookie-jar HTTP client over global fetch ---

const parseSetCookies = (res, jar) => {
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
};

const cookieHeader = (jar) =>
  Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

const http = async (method, path, { body, jar = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
      ...(jar.csrfToken ? { 'x-csrf-token': jar.csrfToken } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  parseSetCookies(res, jar);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data, jar };
};

const bootstrapCsrf = async (jar) => {
  const res = await http('GET', '/api/auth/csrf-token', { jar });
  jar.csrfToken = res.body.csrfToken || jar.csrfToken;
  return res;
};

let userSeq = 0;
const makePasswordUser = async ({ emailVerified = true } = {}) => {
  userSeq += 1;
  const salt = newSalt();
  const user = new User({
    email: `link-user-${userSeq}@example.com`,
    name: `Link User ${userSeq}`,
    emailVerified,
    passwordSalt: salt,
    passwordHash: hashPassword('correct-horse-battery-stable', salt)
  });
  await user.save();
  return user;
};

const loginAs = async (user) => {
  const jar = {};
  await bootstrapCsrf(jar);
  const res = await http('POST', '/api/auth/login', {
    jar, body: { email: user.email, password: 'correct-horse-battery-stable' }
  });
  assert.equal(res.status, 200, 'login should succeed: ' + JSON.stringify(res.body));
  return jar;
};

// Stub the Google verifier: the credential string selects which
// identity the fake Google returns, so each test picks its case.
const stubGoogle = (identities) => {
  googleAuth.verifyGoogleCredential = async (credential) => {
    if (Object.prototype.hasOwnProperty.call(identities, credential)) {
      return identities[credential];
    }
    throw new Error('Invalid Google credential');
  };
};

// --- Lib: linkGoogleAccount ---

test('linkGoogleAccount links a matching Google identity and verifies the email', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser({ emailVerified: false });
  const { user: linked, alreadyLinked } = await linkGoogleAccount(user, {
    googleId: 'google-aaa', email: user.email
  });
  assert.equal(alreadyLinked, false);
  assert.equal(linked.googleId, 'google-aaa');
  assert.equal(linked.emailVerified, true);
  const fresh = await User.findById(user._id);
  assert.equal(fresh.googleId, 'google-aaa');
  assert.equal(fresh.emailVerified, true);
});

test('linkGoogleAccount is idempotent — linking the same Google account again is a no-op success', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  await linkGoogleAccount(user, { googleId: 'google-bbb', email: user.email });
  const again = await linkGoogleAccount(await User.findById(user._id), {
    googleId: 'google-bbb', email: user.email
  });
  assert.equal(again.alreadyLinked, true);
  assert.equal(again.user.googleId, 'google-bbb');
});

test('linkGoogleAccount refuses a Google identity whose email does not match the account', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  await assert.rejects(
    () => linkGoogleAccount(user, { googleId: 'google-ccc', email: 'someone-else@example.com' }),
    (err) => {
      assert.equal(err.code, 'GOOGLE_LINK_EMAIL_MISMATCH');
      return true;
    }
  );
  const fresh = await User.findById(user._id);
  assert.equal(fresh.googleId, undefined);
});

test('linkGoogleAccount refuses a Google account already linked to another user', async (t) => {
  if (skipIfNoMongo(t)) return;
  const first = await makePasswordUser();
  const second = await makePasswordUser();
  await linkGoogleAccount(first, { googleId: 'google-ddd', email: first.email });
  await assert.rejects(
    () => linkGoogleAccount(second, { googleId: 'google-ddd', email: second.email }),
    (err) => {
      assert.equal(err.code, 'GOOGLE_ALREADY_LINKED');
      return true;
    }
  );
  assert.equal((await User.findById(second._id)).googleId, undefined);
});

test('linkGoogleAccount refuses linking a second Google account to one user', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  await linkGoogleAccount(user, { googleId: 'google-eee', email: user.email });
  await assert.rejects(
    async () => linkGoogleAccount(await User.findById(user._id), { googleId: 'google-fff', email: user.email }),
    (err) => {
      assert.equal(err.code, 'GOOGLE_ALREADY_LINKED');
      return true;
    }
  );
  assert.equal((await User.findById(user._id)).googleId, 'google-eee');
});

// --- HTTP: POST /api/auth/google/link ---

test('POST /api/auth/google/link links when signed in as that account', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const jar = await loginAs(user);
  stubGoogle({
    'cred-matching': { googleId: 'google-http-1', email: user.email, name: 'Link User', picture: '' }
  });
  const res = await http('POST', '/api/auth/google/link', { jar, body: { credential: 'cred-matching' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.googleLinked, true);
  assert.equal(res.body.alreadyLinked, false);
  assert.equal(res.body.user.googleLinked, true);
  assert.equal((await User.findById(user._id)).googleId, 'google-http-1');
});

test('POST /api/auth/google/link: already-linked account shows the linked state and does not re-link', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const jar = await loginAs(user);
  stubGoogle({
    'cred-link': { googleId: 'google-http-2', email: user.email, name: 'Link User', picture: '' }
  });
  assert.equal((await http('POST', '/api/auth/google/link', { jar, body: { credential: 'cred-link' } })).status, 200);
  const again = await http('POST', '/api/auth/google/link', { jar, body: { credential: 'cred-link' } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.googleLinked, true);
  assert.equal(again.body.alreadyLinked, true);
  assert.equal((await User.findById(user._id)).googleId, 'google-http-2');
});

test('POST /api/auth/google/link refused when the Google email belongs to a DIFFERENT account', async (t) => {
  if (skipIfNoMongo(t)) return;
  const me = await makePasswordUser();
  const other = await makePasswordUser();
  const jar = await loginAs(me);
  stubGoogle({
    'cred-other': { googleId: 'google-http-3', email: other.email, name: 'Other', picture: '' }
  });
  const res = await http('POST', '/api/auth/google/link', { jar, body: { credential: 'cred-other' } });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'GOOGLE_LINK_EMAIL_MISMATCH');
  assert.equal((await User.findById(me._id)).googleId, undefined);
  assert.equal((await User.findById(other._id)).googleId, undefined);
});

test('POST /api/auth/google/link refused when the Google account is already linked to another user', async (t) => {
  if (skipIfNoMongo(t)) return;
  const first = await makePasswordUser();
  const second = await makePasswordUser();
  const jar1 = await loginAs(first);
  const jar2 = await loginAs(second);
  stubGoogle({
    'cred-shared': { googleId: 'google-http-4', email: first.email, name: 'First', picture: '' },
    'cred-shared-as-second': { googleId: 'google-http-4', email: second.email, name: 'Second', picture: '' }
  });
  assert.equal((await http('POST', '/api/auth/google/link', { jar: jar1, body: { credential: 'cred-shared' } })).status, 200);
  const res = await http('POST', '/api/auth/google/link', { jar: jar2, body: { credential: 'cred-shared-as-second' } });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'GOOGLE_ALREADY_LINKED');
  assert.equal((await User.findById(second._id)).googleId, undefined);
});

test('POST /api/auth/google/link requires a session', async (t) => {
  if (skipIfNoMongo(t)) return;
  const jar = {};
  await bootstrapCsrf(jar);
  stubGoogle({
    'cred-any': { googleId: 'google-http-5', email: 'anyone@example.com', name: 'Any', picture: '' }
  });
  const res = await http('POST', '/api/auth/google/link', { jar, body: { credential: 'cred-any' } });
  assert.equal(res.status, 401, JSON.stringify(res.body));
});

test('POST /api/auth/google/link 401s on an unverifiable credential', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const jar = await loginAs(user);
  stubGoogle({});
  const res = await http('POST', '/api/auth/google/link', { jar, body: { credential: 'cred-bad' } });
  assert.equal(res.status, 401, JSON.stringify(res.body));
  assert.equal((await User.findById(user._id)).googleId, undefined);
});

test('POST /api/auth/google/link 503s when Google sign-in is not configured', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const jar = await loginAs(user);
  stubGoogle({
    'cred-any': { googleId: 'google-http-6', email: user.email, name: 'Any', picture: '' }
  });
  const saved = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  try {
    const res = await http('POST', '/api/auth/google/link', { jar, body: { credential: 'cred-any' } });
    assert.equal(res.status, 503, JSON.stringify(res.body));
  } finally {
    process.env.GOOGLE_CLIENT_ID = saved;
  }
  assert.equal((await User.findById(user._id)).googleId, undefined);
});

// --- HTTP: the M1 guard on /auth/google still holds at route level ---

test('POST /api/auth/google unauthenticated onto a password account email is still refused 409', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  stubGoogle({
    'cred-signin': { googleId: 'google-http-7', email: user.email, name: 'Link User', picture: '' }
  });
  const jar = {};
  await bootstrapCsrf(jar);
  const res = await http('POST', '/api/auth/google', { jar, body: { credential: 'cred-signin' } });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'GOOGLE_LINK_REQUIRES_SIGNIN');
  assert.equal((await User.findById(user._id)).googleId, undefined);
});
