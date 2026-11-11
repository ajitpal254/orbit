// Tests for push subscriptions keyed by (user, endpoint) (audit M5).
//
// The old endpoint-only unique index meant subscribing as account B
// on a shared device silently reassigned account A's row and A's
// pushes stopped arriving. These tests prove, against real MongoDB:
//   - the old index is dropped by syncIndexes() and the compound
//     unique index (user, endpoint) takes its place;
//   - two accounts on one device (same endpoint) both keep their
//     rows, and both receive pushes;
//   - unsubscribe / dead-subscription pruning touch only the
//     caller's own rows.
// DB tests skip when no MongoDB is reachable (same pattern as
// tests/emailVerification.test.js); run a local mongod or set
// MONGODB_URI to exercise them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const webPush = require('web-push');
const User = require('../models/User');
const PushSubscription = require('../models/PushSubscription');
const { hashPassword, newSalt } = require('../lib/passwords');
const { sendPushToUser, pushPayloadFor } = require('../lib/push');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit-test-push-subscriptions';
const PW = 'correct-horse-battery-stable';
const ENDPOINT = 'https://push.example.test/endpoint-shared-device';
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

// --- Minimal cookie-jar HTTP client (same shape as emailVerification.test.js) ---

const parseSetCookies = (res, jar) => {
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
};

const http = async (method, path, { body, jar = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(Object.keys(jar).length ? { Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      ...(jar.csrfToken ? { 'x-csrf-token': jar.csrfToken } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  parseSetCookies(res, jar);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const makeUser = async (email, name) => {
  const salt = newSalt();
  return User.create({
    email, name, emailVerified: true,
    passwordSalt: salt, passwordHash: hashPassword(PW, salt)
  });
};

const login = async (email) => {
  const jar = {};
  const csrf = await http('GET', '/api/auth/csrf-token', { jar });
  jar.csrfToken = csrf.body.csrfToken;
  const res = await http('POST', '/api/auth/login', { jar, body: { email, password: PW } });
  assert.equal(res.status, 200, `login for ${email} should succeed: ${JSON.stringify(res.body)}`);
  return jar;
};

const subscriptionBody = (endpoint, p256dh = 'p256dh-key', auth = 'auth-key') => ({
  subscription: { endpoint, keys: { p256dh, auth } }
});

// A real browser-grade key pair: p256dh is the 65-byte uncompressed
// EC public key, auth a 16-byte secret, both base64url — web-push
// validates the shape before sending, so stub keys must be shaped
// right even when the sender itself is stubbed.
const validKeys = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url')
  };
};

test('syncIndexes drops the old endpoint-only unique index and creates (user, endpoint)', async (t) => {
  skipIfNoMongo(t);
  // Simulate a pre-v0.5.1 deployment: the old unique index exists.
  await PushSubscription.collection.createIndex({ endpoint: 1 }, { unique: true, name: 'endpoint_1' });
  const names = async () =>
    (await PushSubscription.collection.listIndexes().toArray()).map((ix) => ix.name);
  assert.ok((await names()).includes('endpoint_1'), 'old index present before migration');
  // The boot migration (server.js) — driven explicitly here.
  await PushSubscription.syncIndexes();
  const specs = await PushSubscription.collection.listIndexes().toArray();
  const byName = new Map(specs.map((ix) => [ix.name, ix]));
  assert.ok(!byName.has('endpoint_1'), 'old endpoint-only unique index must be gone');
  const compound = byName.get('user_1_endpoint_1');
  assert.ok(compound, 'compound index must exist');
  assert.equal(compound.unique, true, 'compound index must be unique');
  assert.deepEqual(compound.key, { user: 1, endpoint: 1 });
});

test('two accounts on one device keep their own rows; duplicates per user are rejected', async (t) => {
  skipIfNoMongo(t);
  await PushSubscription.syncIndexes();
  const a = await makeUser('push-a@orbit.test', 'Push A');
  const b = await makeUser('push-b@orbit.test', 'Push B');
  await PushSubscription.create({ user: a._id, endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'a' } });
  await PushSubscription.create({ user: b._id, endpoint: ENDPOINT, keys: { p256dh: 'b', auth: 'b' } });
  assert.equal(await PushSubscription.countDocuments({ endpoint: ENDPOINT }), 2, 'one row per user');
  assert.equal(await PushSubscription.countDocuments({ user: a._id }), 1);
  assert.equal(await PushSubscription.countDocuments({ user: b._id }), 1);
  // Same user + same endpoint twice is still a duplicate.
  await assert.rejects(
    () => PushSubscription.create({ user: a._id, endpoint: ENDPOINT, keys: { p256dh: 'a2', auth: 'a2' } }),
    (err) => err.code === 11000
  );
});

test('HTTP: subscribing as B does not reassign A’s row; unsubscribe is scoped to the caller', async (t) => {
  skipIfNoMongo(t);
  await PushSubscription.syncIndexes();
  // A fresh endpoint for this test: the suite shares one database
  // across tests, and the endpoint is the shared-device identity.
  const endpoint = ENDPOINT + '-http';
  const a = await makeUser('http-a@orbit.test', 'Http A');
  const b = await makeUser('http-b@orbit.test', 'Http B');
  const jarA = await login('http-a@orbit.test');
  const jarB = await login('http-b@orbit.test');

  const subA = await http('POST', '/api/push/subscribe', { jar: jarA, body: subscriptionBody(endpoint, 'key-a', 'auth-a') });
  assert.equal(subA.status, 200, JSON.stringify(subA.body));
  const subB = await http('POST', '/api/push/subscribe', { jar: jarB, body: subscriptionBody(endpoint, 'key-b', 'auth-b') });
  assert.equal(subB.status, 200, JSON.stringify(subB.body));

  const rows = await PushSubscription.find({ endpoint }).lean();
  assert.equal(rows.length, 2, 'both accounts keep a subscription for the shared endpoint');
  const rowA = rows.find((r) => String(r.user) === String(a._id));
  const rowB = rows.find((r) => String(r.user) === String(b._id));
  assert.ok(rowA && rowB, 'one row per user');
  assert.equal(rowA.keys.p256dh, 'key-a', 'A’s keys were not overwritten by B');
  assert.equal(rowB.keys.p256dh, 'key-b');

  // Re-subscribing as A updates A's row, not B's, and creates no duplicate.
  const resub = await http('POST', '/api/push/subscribe', { jar: jarA, body: subscriptionBody(endpoint, 'key-a2', 'auth-a2') });
  assert.equal(resub.status, 200);
  assert.equal(await PushSubscription.countDocuments({ endpoint }), 2);
  assert.equal((await PushSubscription.findOne({ user: a._id }).lean()).keys.p256dh, 'key-a2');
  assert.equal((await PushSubscription.findOne({ user: b._id }).lean()).keys.p256dh, 'key-b');

  // Unsubscribing as A removes only A's row.
  const unsub = await http('POST', '/api/push/unsubscribe', { jar: jarA, body: { endpoint } });
  assert.equal(unsub.status, 200);
  assert.equal(await PushSubscription.countDocuments({ user: a._id }), 0);
  assert.equal(await PushSubscription.countDocuments({ user: b._id }), 1, 'B’s row survives A’s unsubscribe');
});

test('both accounts on one device receive pushes; a dead subscription prunes only its owner', async (t) => {
  skipIfNoMongo(t);
  await PushSubscription.syncIndexes();
  const endpoint = ENDPOINT + '-send';
  const a = await makeUser('send-a@orbit.test', 'Send A');
  const b = await makeUser('send-b@orbit.test', 'Send B');
  const keysA = validKeys();
  const keysB = validKeys();
  await PushSubscription.create({ user: a._id, endpoint, keys: keysA });
  await PushSubscription.create({ user: b._id, endpoint, keys: keysB });

  // Real VAPID keys so ensureVapid() passes; the sender is injected
  // (web-push v4 ships ESM with a sealed namespace object, so its
  // sendNotification cannot be monkey-patched) so no push service
  // is ever contacted.
  const keys = webPush.generateVAPIDKeys();
  const savedPub = process.env.VAPID_PUBLIC_KEY;
  const savedPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  const delivered = [];
  const deadKeys = new Set();
  const fakeSend = async (sub) => {
    delivered.push(sub.endpoint);
    if (deadKeys.has(sub.keys.p256dh)) {
      const err = new Error('Gone');
      err.statusCode = 410;
      throw err;
    }
  };
  try {
    const sentA = await sendPushToUser(a._id, pushPayloadFor({ type: 'test', actorName: 'Send A' }), { sendNotification: fakeSend });
    const sentB = await sendPushToUser(b._id, pushPayloadFor({ type: 'test', actorName: 'Send B' }), { sendNotification: fakeSend });
    assert.equal(sentA, 1, 'A receives on the shared endpoint');
    assert.equal(sentB, 1, 'B receives on the shared endpoint');
    assert.equal(delivered.length, 2);

    // B's browser uninstalled: the push service answers 410 for B's
    // row only. Pruning must delete B's row and leave A's alone.
    deadKeys.add(keysB.p256dh);
    const sentB2 = await sendPushToUser(b._id, pushPayloadFor({ type: 'test', actorName: 'Send B' }), { sendNotification: fakeSend });
    assert.equal(sentB2, 0, 'dead subscription sends nothing');
    assert.equal(await PushSubscription.countDocuments({ user: b._id }), 0, 'B’s dead row is pruned');
    assert.equal(await PushSubscription.countDocuments({ user: a._id }), 1, 'A’s row survives B’s prune');
  } finally {
    if (savedPub === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = savedPub;
    if (savedPriv === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = savedPriv;
  }
});
