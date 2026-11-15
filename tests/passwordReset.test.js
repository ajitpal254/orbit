// Tests for the forgot-password flow (v0.9.1).
//
// Two layers, following tests/emailVerification.test.js:
//   - Lib tests (need MongoDB): the token lifecycle — create/consume,
//     single-use, 24h expiry, hash-only storage, session invalidation,
//     and the email send with a stubbed transport.
//   - DB + HTTP tests (need MongoDB): forgot-password always answers
//     200 with the same generic message (unknown/known/invalid email),
//     and reset-password accepts a good token, refuses bad/expired/
//     used tokens and short passwords, and invalidates sessions.
//   When no MongoDB is reachable they skip instead of failing — the
//   suite has no Mongo in CI (see tests/rooms.test.js). Run a local
//   mongod (or set MONGODB_URI) to exercise them.
//
// SMTP is NOT needed for these tests: the email send is exercised
// with a fake transport (or a stubbed fetch for the Brevo API
// branch, mirroring PR #18), and the HTTP forgot-password test runs
// with SMTP unconfigured (the background send then no-ops — the
// token row is still created, the route still answers 200).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const Session = require('../models/Session');
const PasswordResetToken = require('../models/PasswordResetToken');
const { hashPassword, newSalt, hashToken } = require('../lib/passwords');
const {
  PASSWORD_RESET_TTL_MS,
  createPasswordResetToken, sendPasswordResetEmail, resetPasswordWithToken
} = require('../lib/passwordReset');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit-test-password-reset';
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
    email: `reset-user-${userSeq}@example.com`,
    name: `Reset User ${userSeq}`,
    emailVerified,
    passwordSalt: salt,
    passwordHash: hashPassword('old-password-1234', salt)
  });
  await user.save();
  return user;
};

const loginAs = async (user, password = 'old-password-1234') => {
  const jar = {};
  await bootstrapCsrf(jar);
  const res = await http('POST', '/api/auth/login', {
    jar, body: { email: user.email, password }
  });
  assert.equal(res.status, 200, 'login should succeed: ' + JSON.stringify(res.body));
  return jar;
};

// --- Lib: token lifecycle ---

test('reset token TTL is 24 hours', () => {
  assert.equal(PASSWORD_RESET_TTL_MS, 24 * 60 * 60 * 1000);
});

test('createPasswordResetToken stores only the hash, never the raw token', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const raw = await createPasswordResetToken(user._id);
  assert.equal(typeof raw, 'string');
  assert.equal(raw.length, 64);
  const rows = await PasswordResetToken.find({ user: user._id }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenHash, hashToken(raw));
  assert.notEqual(rows[0].tokenHash, raw);
});

test('resetPasswordWithToken resets the password and the token is single-use', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const raw = await createPasswordResetToken(user._id);
  const reset = await resetPasswordWithToken(raw, 'brand-new-password-99');
  assert.ok(reset);
  assert.equal(String(reset._id), String(user._id));
  const fresh = await User.findById(user._id);
  assert.equal(fresh.passwordHash, hashPassword('brand-new-password-99', fresh.passwordSalt));
  assert.notEqual(fresh.passwordHash, hashPassword('old-password-1234', fresh.passwordSalt));
  assert.equal(await PasswordResetToken.countDocuments({ user: user._id }), 0);
  // Second use of the same token fails.
  assert.equal(await resetPasswordWithToken(raw, 'another-new-password'), null);
});

test('resetPasswordWithToken refuses unknown and expired tokens', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  assert.equal(await resetPasswordWithToken('no-such-token', 'brand-new-password-99'), null);
  const raw = await createPasswordResetToken(user._id);
  await PasswordResetToken.updateOne(
    { user: user._id },
    { $set: { expiresAt: new Date(Date.now() - 1000) } }
  );
  assert.equal(await resetPasswordWithToken(raw, 'brand-new-password-99'), null);
  const fresh = await User.findById(user._id);
  assert.equal(fresh.passwordHash, hashPassword('old-password-1234', fresh.passwordSalt));
});

test('resetPasswordWithToken refuses a short password WITHOUT spending the token', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const raw = await createPasswordResetToken(user._id);
  assert.equal(await resetPasswordWithToken(raw, 'short'), null);
  // The token is still good afterwards.
  const reset = await resetPasswordWithToken(raw, 'brand-new-password-99');
  assert.ok(reset);
});

test('resetPasswordWithToken deletes every session the user holds', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const jar1 = await loginAs(user);
  const jar2 = await loginAs(user);
  assert.equal(await Session.countDocuments({ userId: user._id }), 2);
  const raw = await createPasswordResetToken(user._id);
  await resetPasswordWithToken(raw, 'brand-new-password-99');
  assert.equal(await Session.countDocuments({ userId: user._id }), 0);
  // Both old sessions are dead.
  assert.equal((await http('GET', '/api/auth/me', { jar: jar1 })).status, 401);
  assert.equal((await http('GET', '/api/auth/me', { jar: jar2 })).status, 401);
});

test('a fresh reset token revokes outstanding ones', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const first = await createPasswordResetToken(user._id);
  const second = await createPasswordResetToken(user._id);
  assert.notEqual(first, second);
  assert.equal(await resetPasswordWithToken(first, 'brand-new-password-99'), null);
  assert.ok(await resetPasswordWithToken(second, 'brand-new-password-99'));
});

// --- Lib: email send (stubbed transport) ---

test('sendPasswordResetEmail sends a #reset-password- link the token redeems', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const sent = [];
  const fakeTransport = {
    sendMail: async (mail) => { sent.push(mail); return { messageId: 'fake-1' }; }
  };
  const createTransport = () => fakeTransport;
  // SMTP env must look configured for getTransport to build one;
  // the fake createTransport means no real server is ever contacted.
  // BREVO_API_KEY must be unset or the send would route to the API
  // branch instead of the stubbed transport.
  const saved = {};
  for (const k of ['BREVO_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_USER = 'orbit@example.com';
  process.env.SMTP_PASS = 'fake-pass';
  process.env.SMTP_FROM = 'orbit@example.com';
  process.env.APP_URL = 'https://orbit.example.com';
  try {
    const result = await sendPasswordResetEmail(user, { createTransport });
    assert.deepEqual(result, { sent: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, user.email);
  assert.match(sent[0].subject, /Reset your Orbit password/);
  const match = sent[0].text.match(/#reset-password-([0-9a-f]{64})/);
  assert.ok(match, 'email text carries a reset link, got: ' + sent[0].text);
  assert.ok(await resetPasswordWithToken(match[1], 'brand-new-password-99'));
});

test('sendPasswordResetEmail reports send-failed instead of throwing', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const saved = {};
  for (const k of ['BREVO_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_USER = 'orbit@example.com';
  process.env.SMTP_PASS = 'fake-pass';
  try {
    const result = await sendPasswordResetEmail(user, {
      createTransport: () => ({
        sendMail: async () => { throw new Error('connection refused'); }
      })
    });
    assert.deepEqual(result, { sent: false, reason: 'send-failed' });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('sendPasswordResetEmail reports smtp-not-configured when SMTP is unset', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const saved = {};
  for (const k of ['BREVO_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const result = await sendPasswordResetEmail(user);
    assert.deepEqual(result, { sent: false, reason: 'smtp-not-configured' });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// --- Lib: Brevo API branch (mirrors PR #18 / emailVerification) ---

test('Brevo API mode: sendPasswordResetEmail uses the API when BREVO_API_KEY is set, SMTP unset', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const saved = {};
  for (const k of ['BREVO_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  process.env.SMTP_FROM = 'Orbit <orbit@example.test>';
  process.env.APP_URL = 'https://orbit.example.test';
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 201, json: async () => ({ messageId: 'api-1' }) };
  };
  try {
    const result = await sendPasswordResetEmail(user, { fetchImpl });
    assert.deepEqual(result, { sent: true });
    assert.ok(seen, 'mail was handed to the Brevo API');
    assert.equal(seen.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(seen.opts.headers['api-key'], 'xkeysib-test-key');
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.sender.email, 'orbit@example.test');
    assert.deepEqual(body.to, [{ email: user.email }]);
    assert.match(body.textContent, /#reset-password-[0-9a-f]{64}/, 'link carries the token in a hash');
    const token = body.textContent.match(/#reset-password-([0-9a-f]{64})/)[1];
    assert.ok(await resetPasswordWithToken(token, 'brand-new-password-99'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('Brevo API mode: an API rejection reports brevo-api-rejected instead of throwing', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const saved = {};
  for (const k of ['BREVO_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  const fetchImpl = async () => ({
    ok: false, status: 400, json: async () => ({ message: 'bad sender' })
  });
  try {
    const result = await sendPasswordResetEmail(user, { fetchImpl });
    assert.deepEqual(result, { sent: false, reason: 'brevo-api-rejected' });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// --- HTTP: forgot-password never reveals whether the email exists ---

const GENERIC = 'If an account exists for that email, a password-reset link is on its way — check your inbox.';

test('POST /api/auth/forgot-password answers 200 with the generic message for an unknown email', async (t) => {
  if (skipIfNoMongo(t)) return;
  const before = await PasswordResetToken.countDocuments({});
  const jar = {};
  await bootstrapCsrf(jar);
  const res = await http('POST', '/api/auth/forgot-password', {
    jar, body: { email: 'nobody-here@example.com' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, GENERIC);
  // No token row was created for an email with no account.
  assert.equal(await PasswordResetToken.countDocuments({}), before);
});

test('POST /api/auth/forgot-password answers the SAME 200 for a known email and creates a token', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const jar = {};
  await bootstrapCsrf(jar);
  const res = await http('POST', '/api/auth/forgot-password', {
    jar, body: { email: user.email }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, GENERIC);
  // The send runs in the background (mail must never hold up the
  // response); the token row lands a moment later — poll for it.
  let rows = 0;
  for (let i = 0; i < 50 && rows === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    rows = await PasswordResetToken.countDocuments({ user: user._id });
  }
  assert.equal(rows, 1);
});

test('POST /api/auth/forgot-password answers 200 for a malformed email too', async (t) => {
  if (skipIfNoMongo(t)) return;
  const jar = {};
  await bootstrapCsrf(jar);
  const res = await http('POST', '/api/auth/forgot-password', {
    jar, body: { email: 'not-an-email' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, GENERIC);
});

// --- HTTP: reset-password ---

test('POST /api/auth/reset-password: full flow — old password dies, new password works, token spent', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const raw = await createPasswordResetToken(user._id);
  const jar = {};
  await bootstrapCsrf(jar);
  const res = await http('POST', '/api/auth/reset-password', {
    jar, body: { token: raw, newPassword: 'brand-new-password-99' }
  });
  assert.equal(res.status, 200);
  assert.match(res.body.message, /Password reset/);
  // Reusing the token fails.
  const reuse = await http('POST', '/api/auth/reset-password', {
    jar, body: { token: raw, newPassword: 'another-new-password' }
  });
  assert.equal(reuse.status, 400);
  // Old password no longer works; new one does.
  const oldLogin = await http('POST', '/api/auth/login', {
    jar, body: { email: user.email, password: 'old-password-1234' }
  });
  assert.equal(oldLogin.status, 401);
  const newJar = await loginAs(user, 'brand-new-password-99');
  assert.equal((await http('GET', '/api/auth/me', { jar: newJar })).status, 200);
});

test('POST /api/auth/reset-password refuses a bad token and a short password', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const raw = await createPasswordResetToken(user._id);
  const jar = {};
  await bootstrapCsrf(jar);
  const bad = await http('POST', '/api/auth/reset-password', {
    jar, body: { token: 'no-such-token', newPassword: 'brand-new-password-99' }
  });
  assert.equal(bad.status, 400);
  const short = await http('POST', '/api/auth/reset-password', {
    jar, body: { token: raw, newPassword: 'short' }
  });
  assert.equal(short.status, 400);
  // The short-password attempt did not spend the token.
  const ok = await http('POST', '/api/auth/reset-password', {
    jar, body: { token: raw, newPassword: 'brand-new-password-99' }
  });
  assert.equal(ok.status, 200);
});

test('POST /api/auth/reset-password invalidates a live session', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser();
  const jar = await loginAs(user);
  assert.equal((await http('GET', '/api/auth/me', { jar })).status, 200);
  const raw = await createPasswordResetToken(user._id);
  const jar2 = {};
  await bootstrapCsrf(jar2);
  const res = await http('POST', '/api/auth/reset-password', {
    jar: jar2, body: { token: raw, newPassword: 'brand-new-password-99' }
  });
  assert.equal(res.status, 200);
  assert.equal((await http('GET', '/api/auth/me', { jar })).status, 401);
});
