// Tests for email verification + the Google link guard (audit M1).
//
// Two layers, following the suite's existing patterns:
//   - Pure/lib tests (always run): isEmailVerified, the 24h TTL,
//     the SMTP-unset mode, token hashing, and the Google link guard.
//   - DB + HTTP tests (need MongoDB): the token lifecycle, the
//     search/invite/room-create gates, grandfathering, and the
//     verify/resend endpoints against the real Express app. When no
//     MongoDB is reachable they skip instead of failing — the suite
//     has no Mongo in CI (see tests/rooms.test.js). Run a local
//     mongod (or set MONGODB_URI) to exercise them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const EmailVerificationToken = require('../models/EmailVerificationToken');
const { hashPassword, newSalt } = require('../lib/passwords');
const {
  EMAIL_VERIFICATION_TTL_MS, isEmailVerified, isSmtpConfigured,
  createVerificationToken, sendVerificationEmail, verifyEmailToken
} = require('../lib/emailVerification');
const { findOrCreateGoogleUser } = require('../lib/googleAuth');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit-test-email-verification';
let mongoAvailable = false;
let server = null;
let base = '';

const skipIfNoMongo = (t) => {
  if (!mongoAvailable) t.skip('no MongoDB reachable at ' + MONGO_URI);
};

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    mongoAvailable = true;
    await mongoose.connection.db.dropDatabase();
    // The real app, on an ephemeral port — no listen in server.js
    // unless it is the main module, so this is safe to import.
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

const makePasswordUser = async ({ email, name, emailVerified }) => {
  const salt = newSalt();
  const fields = {
    email, name, passwordSalt: salt,
    passwordHash: hashPassword('correct-horse-battery-stable', salt)
  };
  if (emailVerified !== undefined) fields.emailVerified = emailVerified;
  return User.create(fields);
};

const login = async (email) => {
  const jar = {};
  await bootstrapCsrf(jar);
  const res = await http('POST', '/api/auth/login', {
    jar, body: { email, password: 'correct-horse-battery-stable' }
  });
  assert.equal(res.status, 200, `login for ${email} should succeed: ${JSON.stringify(res.body)}`);
  return { jar, user: res.body.user };
};

// --- Pure tests (always run) ---

test('isEmailVerified: missing field counts as verified (grandfathered)', () => {
  assert.equal(isEmailVerified({}), true);
  assert.equal(isEmailVerified({ emailVerified: true }), true);
  assert.equal(isEmailVerified({ emailVerified: false }), false);
  assert.equal(isEmailVerified(null), true);
});

test('verification tokens live 24h', () => {
  assert.equal(EMAIL_VERIFICATION_TTL_MS, 24 * 60 * 60 * 1000);
});

test('SMTP-unset mode: isSmtpConfigured is false without env', () => {
  const saved = {};
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    assert.equal(isSmtpConfigured(), false);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// --- DB tests: token lifecycle ---

test('verification token is stored only as a hash, expires in 24h', async (t) => {
  skipIfNoMongo(t);
  const user = await makePasswordUser({ email: 'hashcheck@orbit.test', name: 'Hash', emailVerified: false });
  const raw = await createVerificationToken(user._id);
  assert.match(raw, /^[0-9a-f]{64}$/);
  const row = await EmailVerificationToken.findOne({ user: user._id }).lean();
  assert.ok(row, 'token row exists');
  assert.match(row.tokenHash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.tokenHash, raw);
  assert.ok(!JSON.stringify(row).includes(raw), 'raw token is nowhere in the stored row');
  const skew = new Date(row.expiresAt).getTime() - Date.now();
  assert.ok(skew > 23 * 60 * 60 * 1000 && skew <= 24 * 60 * 60 * 1000, 'expires ~24h out');
});

test('verifyEmailToken is single-use and refuses expired tokens', async (t) => {
  skipIfNoMongo(t);
  const user = await makePasswordUser({ email: 'singleuse@orbit.test', name: 'Single', emailVerified: false });
  const raw = await createVerificationToken(user._id);
  const verified = await verifyEmailToken(raw);
  assert.ok(verified, 'first verify succeeds');
  assert.equal(verified.emailVerified, true);
  assert.equal(await verifyEmailToken(raw), null, 'same token cannot verify twice');
  assert.equal(await verifyEmailToken('0'.repeat(64)), null, 'unknown token refused');

  const user2 = await makePasswordUser({ email: 'expired@orbit.test', name: 'Expired', emailVerified: false });
  const raw2 = await createVerificationToken(user2._id);
  await EmailVerificationToken.updateOne(
    { user: user2._id },
    { $set: { expiresAt: new Date(Date.now() - 1000) } }
  );
  assert.equal(await verifyEmailToken(raw2), null, 'expired token refused');
  const reloaded = await User.findById(user2._id).lean();
  assert.equal(reloaded.emailVerified, false, 'expired verify leaves the account unverified');
});

test('sendVerificationEmail sends a hash link with a stubbed transport', async (t) => {
  skipIfNoMongo(t);
  const saved = {};
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL']) {
    saved[k] = process.env[k];
  }
  process.env.SMTP_HOST = 'smtp.example.test';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_USER = 'orbit@example.test';
  process.env.SMTP_PASS = 'placeholder-only';
  process.env.SMTP_FROM = 'Orbit <orbit@example.test>';
  process.env.APP_URL = 'https://orbit.example.test';
  let captured = null;
  const fakeTransport = {
    sendMail: async (opts) => { captured = opts; return { messageId: 'fake' }; }
  };
  try {
    const user = await makePasswordUser({ email: 'mailed@orbit.test', name: 'Mailed', emailVerified: false });
    const result = await sendVerificationEmail(user, {
      createTransport: () => fakeTransport
    });
    assert.deepEqual(result, { sent: true });
    assert.ok(captured, 'mail was handed to the transport');
    assert.equal(captured.to, 'mailed@orbit.test');
    assert.match(captured.text, /#verify-email-[0-9a-f]{64}/, 'link carries the token in a hash');
    assert.ok(!captured.text.includes('/api/auth/verify-email'), 'no token-bearing API URL in the mail');
    // The emailed token actually verifies the account.
    const token = captured.text.match(/#verify-email-([0-9a-f]{64})/)[1];
    const verified = await verifyEmailToken(token);
    assert.ok(verified && verified.emailVerified === true);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('SMTP-unset mode: send fails closed and the account stays unverified', async (t) => {
  skipIfNoMongo(t);
  const saved = {};
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const user = await makePasswordUser({ email: 'nosmtp@orbit.test', name: 'NoSmtp', emailVerified: false });
    const result = await sendVerificationEmail(user);
    assert.deepEqual(result, { sent: false, reason: 'smtp-not-configured' });
    const reloaded = await User.findById(user._id).lean();
    assert.equal(reloaded.emailVerified, false, 'nobody is auto-verified when SMTP is unset');
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// --- DB tests: Google link guard ---

test('Google sign-in onto a password account is refused while signed out', async (t) => {
  skipIfNoMongo(t);
  const victim = await makePasswordUser({ email: 'victim@orbit.test', name: 'Victim', emailVerified: true });
  await assert.rejects(
    () => findOrCreateGoogleUser({ googleId: 'google-attacker', email: 'victim@orbit.test', name: 'Victim' }),
    (err) => {
      assert.equal(err.code, 'GOOGLE_LINK_REQUIRES_SIGNIN');
      assert.match(err.message, /Sign in with your password first/);
      return true;
    }
  );
  const reloaded = await User.findById(victim._id).lean();
  assert.equal(reloaded.googleId, undefined, 'no Google identity was linked');
  assert.equal(await User.countDocuments({ email: 'victim@orbit.test' }), 1, 'no second account created');
});

test('Google link succeeds when signed in as that account, and verifies the email', async (t) => {
  skipIfNoMongo(t);
  const user = await makePasswordUser({ email: 'linkme@orbit.test', name: 'Link', emailVerified: false });
  const linked = await findOrCreateGoogleUser(
    { googleId: 'google-linkme', email: 'linkme@orbit.test', name: 'Link' },
    { currentUserId: user._id }
  );
  assert.equal(String(linked._id), String(user._id));
  assert.equal(linked.googleId, 'google-linkme');
  assert.equal(linked.emailVerified, true, 'Google attests the email, so linking verifies it');
});

test('Google sign-in with a fresh email creates a verified Google-only account', async (t) => {
  skipIfNoMongo(t);
  const created = await findOrCreateGoogleUser(
    { googleId: 'google-fresh', email: 'fresh@orbit.test', name: 'Fresh' }
  );
  assert.equal(created.email, 'fresh@orbit.test');
  assert.equal(created.googleId, 'google-fresh');
  assert.equal(created.emailVerified, true);
  // A second sign-in with the same Google id returns the same user.
  const again = await findOrCreateGoogleUser(
    { googleId: 'google-fresh', email: 'fresh@orbit.test', name: 'Fresh' }
  );
  assert.equal(String(again._id), String(created._id));
});

// --- HTTP tests: registration + gates + verify/resend ---

test('HTTP: register creates an unverified account, login still works', async (t) => {
  skipIfNoMongo(t);
  const jar = {};
  await bootstrapCsrf(jar);
  const res = await http('POST', '/api/auth/register', {
    jar,
    body: { email: 'newbie@orbit.test', password: 'correct-horse-battery-stable', name: 'Newbie Unverified' }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body)); // issueSession answers 200, as before
  assert.equal(res.body.user.emailVerified, false);
  assert.equal(res.body.verificationEmailSent, false, 'SMTP is unset in tests — no mail, no silent verify');
  const reloaded = await User.findOne({ email: 'newbie@orbit.test' }).lean();
  assert.equal(reloaded.emailVerified, false);
  // Login stays allowed so the user can reach verify/resend.
  const loginRes = await http('POST', '/api/auth/login', {
    jar, body: { email: 'newbie@orbit.test', password: 'correct-horse-battery-stable' }
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.user.emailVerified, false);
});

test('HTTP: unverified account is hidden from search and cannot invite or create rooms', async (t) => {
  skipIfNoMongo(t);
  const { jar: unverifiedJar } = await login('newbie@orbit.test');
  const verified = await makePasswordUser({ email: 'verifier@orbit.test', name: 'Verifier Person', emailVerified: true });
  const { jar: verifiedJar } = await login('verifier@orbit.test');

  // Hidden from search: the verified user searches for the unverified one.
  const search = await http('GET', '/api/users/search?q=Newbie', { jar: verifiedJar });
  assert.equal(search.status, 200);
  assert.ok(!search.body.some((u) => u.email === 'newbie@orbit.test'), 'unverified user must not appear in search');

  // Cannot create a room.
  const room = await http('POST', '/api/rooms', { jar: unverifiedJar, body: { name: 'Nope Room' } });
  assert.equal(room.status, 403, JSON.stringify(room.body));
  assert.match(room.body.error, /Verify your email/);

  // Cannot send a friend request.
  const fr = await http('POST', '/api/friends/request', { jar: unverifiedJar, body: { userId: String(verified._id) } });
  assert.equal(fr.status, 403);
  assert.match(fr.body.error, /Verify your email/);

  // Cannot send a room invite (gate fires before the room lookup).
  const inv = await http('POST', `/api/rooms/${new mongoose.Types.ObjectId()}/invite`, {
    jar: unverifiedJar, body: { userId: String(verified._id) }
  });
  assert.equal(inv.status, 403);
  assert.match(inv.body.error, /Verify your email/);

  // The verified user CAN do all three (room create proves it end to end).
  const okRoom = await http('POST', '/api/rooms', { jar: verifiedJar, body: { name: 'Verified Room' } });
  assert.equal(okRoom.status, 201, JSON.stringify(okRoom.body));
});

test('HTTP: grandfathered account (no emailVerified field) is unaffected', async (t) => {
  skipIfNoMongo(t);
  // Insert raw, with no emailVerified field at all — a pre-change row.
  const salt = newSalt();
  const { insertedId } = await User.collection.insertOne({
    email: 'grandpa@orbit.test',
    name: 'Grandpa Oldtimer',
    passwordSalt: salt,
    passwordHash: hashPassword('correct-horse-battery-stable', salt),
    createdAt: new Date(), updatedAt: new Date()
  });
  const { jar } = await login('grandpa@orbit.test');
  const me = await http('GET', '/api/auth/me', { jar });
  assert.equal(me.body.user.emailVerified, true, 'grandfathered account reads as verified');

  // Appears in search and can create a room.
  const { jar: searcherJar } = await login('verifier@orbit.test');
  const search = await http('GET', '/api/users/search?q=Grandpa', { jar: searcherJar });
  assert.ok(search.body.some((u) => u.email === 'grandpa@orbit.test'), 'grandfathered user appears in search');
  const room = await http('POST', '/api/rooms', { jar, body: { name: 'Grandpa Room' } });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  assert.equal(String(insertedId), room.body.createdBy);
});

test('HTTP: verify endpoint consumes the token, then the gates lift', async (t) => {
  skipIfNoMongo(t);
  const user = await User.findOne({ email: 'newbie@orbit.test' });
  const raw = await createVerificationToken(user._id);
  const jar = {};
  await bootstrapCsrf(jar);
  const res = await http('POST', '/api/auth/verify-email', { jar, body: { token: raw } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.verified, true);
  assert.equal(res.body.user.emailVerified, true);
  // Single-use over HTTP too.
  const again = await http('POST', '/api/auth/verify-email', { jar, body: { token: raw } });
  assert.equal(again.status, 400);
  // Gates lift: the newly verified account can now create a room.
  const { jar: freshJar } = await login('newbie@orbit.test');
  const room = await http('POST', '/api/rooms', { jar: freshJar, body: { name: 'Newbie Room' } });
  assert.equal(room.status, 201, JSON.stringify(room.body));
});

test('HTTP: resend is 503 when SMTP is unset, and a no-op when already verified', async (t) => {
  skipIfNoMongo(t);
  const pending = await makePasswordUser({ email: 'resend@orbit.test', name: 'Resend Me', emailVerified: false });
  const { jar } = await login('resend@orbit.test');
  const res = await http('POST', '/api/auth/resend-verification', { jar, body: {} });
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.match(res.body.error, /not set up/);
  assert.equal((await User.findById(pending._id).lean()).emailVerified, false);

  const { jar: verifiedJar } = await login('verifier@orbit.test');
  const already = await http('POST', '/api/auth/resend-verification', { jar: verifiedJar, body: {} });
  assert.equal(already.status, 200);
  assert.equal(already.body.alreadyVerified, true);
});
