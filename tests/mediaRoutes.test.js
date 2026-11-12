// Tests for media sharing routes (v0.8.0): upload / download / unfurl
// against the real Express app, plus the socket chat-message media
// path through attachSocket with a fake io.
//
// DB + HTTP tests (need MongoDB): when no MongoDB is reachable they
// skip instead of failing — same pattern as
// tests/emailVerification.test.js. Run a local mongod (or set
// MONGODB_URI) to exercise them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const Session = require('../models/Session');
const Friendship = require('../models/Friendship');
const Message = require('../models/Message');
const DirectMessage = require('../models/DirectMessage');
const LinkPreview = require('../models/LinkPreview');
const { hashPassword, newSalt, generateToken, hashToken } = require('../lib/passwords');
const { ensureMediaIndexes } = require('../lib/media');
const { attachSocket } = require('../lib/socket');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit-test-media';
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

// --- Minimal cookie-jar HTTP client (same shape as pushSubscriptions.test.js) ---

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
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// Raw fetch for binary downloads (no JSON parsing).
const httpRaw = async (method, path, { jar = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
      ...(jar.csrfToken ? { 'x-csrf-token': jar.csrfToken } : {})
    }
  });
  parseSetCookies(res, jar);
  return { status: res.status, contentType: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
};

// Multipart upload via the global fetch + FormData (no JSON content-type:
// fetch sets the multipart boundary itself).
const upload = async (jar, { buffer, filename, mimetype, width, height } = {}) => {
  const form = new FormData();
  if (buffer !== undefined) {
    form.append('file', new Blob([buffer], { type: mimetype || 'image/png' }), filename || 'photo.png');
  }
  if (width !== undefined) form.append('width', String(width));
  if (height !== undefined) form.append('height', String(height));
  const res = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(jar),
      ...(jar.csrfToken ? { 'x-csrf-token': jar.csrfToken } : {})
    },
    body: form
  });
  parseSetCookies(res, jar);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

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
  const csrf = await http('GET', '/api/auth/csrf-token', { jar });
  jar.csrfToken = csrf.body.csrfToken;
  const res = await http('POST', '/api/auth/login', { jar, body: { email, password: PW } });
  assert.equal(res.status, 200, `login for ${email} should succeed: ${JSON.stringify(res.body)}`);
  return jar;
};

// 1x1 PNG (valid image bytes).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG_MIN = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const EXE_BYTES = Buffer.from('MZ this is really an executable, not an image', 'ascii');

let alice, bob, carol, aliceJar, bobJar, carolJar, publicRoom, privateRoom;

const setupUsersAndRooms = async () => {
  alice = await makeUser('alice-media@example.com', 'Alice');
  bob = await makeUser('bob-media@example.com', 'Bob');
  carol = await makeUser('carol-media@example.com', 'Carol');
  aliceJar = await login('alice-media@example.com');
  bobJar = await login('bob-media@example.com');
  carolJar = await login('carol-media@example.com');
  await Friendship.create({ requester: alice._id, recipient: bob._id, status: 'accepted' });
  const pub = await http('POST', '/api/rooms', { jar: aliceJar, body: { name: 'Media Room' } });
  assert.equal(pub.status, 201, `public room create: ${JSON.stringify(pub.body)}`);
  publicRoom = pub.body;
  const priv = await http('POST', '/api/rooms', { jar: aliceJar, body: { name: 'Private Media Room', isPrivate: true } });
  assert.equal(priv.status, 201, `private room create: ${JSON.stringify(priv.body)}`);
  privateRoom = priv.body;
};

// --- Upload ---

test('upload: a valid PNG stores in GridFS and returns its media URL', async (t) => {
  if (skipIfNoMongo(t)) return;
  await setupUsersAndRooms();
  const res = await upload(aliceJar, { buffer: PNG_1X1, filename: 'cat.png', width: 1, height: 1 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.url, /^\/api\/media\/[0-9a-f]{24}$/);
  assert.equal(res.body.type, 'image');
  assert.equal(res.body.width, 1);
  assert.equal(res.body.height, 1);
  assert.equal(res.body.name, 'cat.png');
  const fileId = res.body.url.split('/').pop();
  const file = await mongoose.connection.db.collection('media.files').findOne({ _id: new mongoose.Types.ObjectId(fileId) });
  assert.ok(file, 'GridFS file row must exist');
  assert.equal(file.metadata.contentType, 'image/png');
  assert.equal(file.metadata.uploaderId, String(alice._id));
  assert.equal(file.metadata.originalName, 'cat.png');
  assert.ok(file.metadata.expireAt instanceof Date, 'provisional expiry must be set');
  assert.ok(!file.metadata.messageId, 'unclaimed upload has no message yet');
});

test('upload: rejects non-images, renamed executables, oversize files, and missing files', async (t) => {
  if (skipIfNoMongo(t)) return;
  const pdf = await upload(aliceJar, { buffer: Buffer.from('%PDF-1.4 fake', 'ascii'), filename: 'doc.pdf', mimetype: 'application/pdf' });
  assert.equal(pdf.status, 400);
  assert.match(pdf.body.error, /Only images/);
  const exe = await upload(aliceJar, { buffer: EXE_BYTES, filename: 'evil.png', mimetype: 'image/png' });
  assert.equal(exe.status, 400);
  assert.match(exe.body.error, /not a valid image/);
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10 * 1024 * 1024 + 1)]);
  const over = await upload(aliceJar, { buffer: big, filename: 'big.png', mimetype: 'image/png' });
  assert.equal(over.status, 413);
  assert.match(over.body.error, /10MB/);
  const none = await upload(aliceJar, {});
  assert.equal(none.status, 400);
  assert.match(none.body.error, /No image/);
});

test('upload: unauthenticated requests are refused', async (t) => {
  if (skipIfNoMongo(t)) return;
  // A CSRF token but no session: the 401 must come from auth, not CSRF.
  const jar = {};
  const csrf = await http('GET', '/api/auth/csrf-token', { jar });
  jar.csrfToken = csrf.body.csrfToken;
  const res = await upload(jar, { buffer: PNG_1X1 });
  assert.equal(res.status, 401);
});

// --- Room messages with media (REST path) ---

test('room message with media: stored, file linked to the message, downloadable by a member', async (t) => {
  if (skipIfNoMongo(t)) return;
  const up = await upload(aliceJar, { buffer: JPEG_MIN, filename: 'pic.jpg', mimetype: 'image/jpeg', width: 640, height: 480 });
  assert.equal(up.status, 201);
  const media = { url: up.body.url, type: 'image', width: 640, height: 480, name: 'pic.jpg' };
  const sent = await http('POST', `/api/rooms/${publicRoom.id}/messages`, { jar: aliceJar, body: { text: 'look at this', media } });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.media.url, up.body.url);
  assert.equal(sent.body.media.width, 640);
  const stored = await Message.findById(sent.body.id).lean();
  assert.ok(stored.media, 'media must be stored on the message');
  // withExpiry stamps from the call time while createdAt is stamped at
  // save time, so allow a small skew — the two are the same 24h window.
  const skew = Math.abs(
    new Date(stored.expireAt).getTime() -
    (new Date(stored.createdAt).getTime() + 24 * 60 * 60 * 1000)
  );
  assert.ok(skew < 5000, `message expiry must be createdAt + 24h (skew ${skew}ms)`);
  const fileId = up.body.url.split('/').pop();
  const file = await mongoose.connection.db.collection('media.files').findOne({ _id: new mongoose.Types.ObjectId(fileId) });
  assert.equal(String(file.metadata.messageId), String(stored._id), 'file must be linked to the message');
  assert.equal(new Date(file.metadata.expireAt).getTime(), new Date(stored.expireAt).getTime(), 'file expiry must match the message expiry');
  // A room member (bob — public room) can download it.
  const got = await httpRaw('GET', up.body.url, { jar: bobJar });
  assert.equal(got.status, 200);
  assert.equal(got.contentType, 'image/jpeg');
  assert.ok(got.buf.equals(JPEG_MIN), 'downloaded bytes must match the upload');
});

test('room message: media-only (no caption) sends; a foreign URL or someone else\'s upload is refused', async (t) => {
  if (skipIfNoMongo(t)) return;
  const up = await upload(aliceJar, { buffer: PNG_1X1, filename: 'solo.png' });
  assert.equal(up.status, 201);
  const solo = await http('POST', `/api/rooms/${publicRoom.id}/messages`, { jar: aliceJar, body: { text: '', media: { url: up.body.url, type: 'image', name: 'solo.png' } } });
  assert.equal(solo.status, 201, JSON.stringify(solo.body));
  assert.equal(solo.body.text, '');
  assert.equal(solo.body.media.url, up.body.url);
  // The same upload cannot be sent twice.
  const reuse = await http('POST', `/api/rooms/${publicRoom.id}/messages`, { jar: aliceJar, body: { text: 'again', media: { url: up.body.url, type: 'image' } } });
  assert.equal(reuse.status, 400);
  assert.match(reuse.body.error, /already sent/);
  // Bob cannot attach Alice's fresh upload.
  const bobs = await upload(bobJar, { buffer: PNG_1X1, filename: 'bobs.png' });
  assert.equal(bobs.status, 201);
  const theft = await http('POST', `/api/rooms/${publicRoom.id}/messages`, { jar: aliceJar, body: { text: 'mine now', media: { url: bobs.body.url, type: 'image' } } });
  assert.equal(theft.status, 400);
  assert.match(theft.body.error, /not found/);
  // A remote URL is never accepted as media.
  const remote = await http('POST', `/api/rooms/${publicRoom.id}/messages`, { jar: aliceJar, body: { text: 'x', media: { url: 'https://evil.example/x.png', type: 'image' } } });
  assert.equal(remote.status, 400);
  assert.match(remote.body.error, /Invalid image/);
  // Empty text with no media is still empty.
  const empty = await http('POST', `/api/rooms/${publicRoom.id}/messages`, { jar: aliceJar, body: { text: '   ' } });
  assert.equal(empty.status, 400);
});

// --- Download access + expiry ---

test('media download: private-room images are invisible to non-members; expired files 404', async (t) => {
  if (skipIfNoMongo(t)) return;
  const up = await upload(aliceJar, { buffer: PNG_1X1, filename: 'secret.png' });
  assert.equal(up.status, 201);
  const sent = await http('POST', `/api/rooms/${privateRoom.id}/messages`, { jar: aliceJar, body: { text: 'members only', media: { url: up.body.url, type: 'image', name: 'secret.png' } } });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  // Carol is not a member of the private room.
  const denied = await httpRaw('GET', up.body.url, { jar: carolJar });
  assert.equal(denied.status, 404);
  // The uploader can always fetch their own image.
  const mine = await httpRaw('GET', up.body.url, { jar: aliceJar });
  assert.equal(mine.status, 200);
  // Expire the file: reads enforce expiry immediately, before any TTL sweep.
  const fileId = up.body.url.split('/').pop();
  await mongoose.connection.db.collection('media.files').updateOne(
    { _id: new mongoose.Types.ObjectId(fileId) },
    { $set: { 'metadata.expireAt': new Date(Date.now() - 1000) } }
  );
  const expired = await httpRaw('GET', up.body.url, { jar: aliceJar });
  assert.equal(expired.status, 404);
  // Unknown ids 404 (and never 403 — existence is not leaked).
  const unknown = await httpRaw('GET', '/api/media/aaaaaaaaaaaaaaaaaaaaaaaa', { jar: aliceJar });
  assert.equal(unknown.status, 404);
  const malformed = await httpRaw('GET', '/api/media/not-an-id', { jar: aliceJar });
  assert.equal(malformed.status, 404);
});

// --- DMs with media ---

test('DM with media: sends, shows in the thread, and only the participants can download it', async (t) => {
  if (skipIfNoMongo(t)) return;
  const up = await upload(aliceJar, { buffer: PNG_1X1, filename: 'dm.png' });
  assert.equal(up.status, 201);
  const sent = await http('POST', `/api/dms/${bob._id}`, { jar: aliceJar, body: { text: '', media: { url: up.body.url, type: 'image', name: 'dm.png' } } });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.media.url, up.body.url);
  const stored = await DirectMessage.findById(sent.body.id).lean();
  assert.ok(stored.media, 'media must be stored on the DM');
  const thread = await http('GET', `/api/dms/${alice._id}`, { jar: bobJar });
  assert.equal(thread.status, 200);
  assert.equal(thread.body.length, 1);
  assert.equal(thread.body[0].media.url, up.body.url);
  const bobGot = await httpRaw('GET', up.body.url, { jar: bobJar });
  assert.equal(bobGot.status, 200);
  const carolGot = await httpRaw('GET', up.body.url, { jar: carolJar });
  assert.equal(carolGot.status, 404);
  // The DM list preview carries the media through.
  const list = await http('GET', '/api/dms', { jar: bobJar });
  assert.equal(list.status, 200);
  const aliceRow = list.body.find((r) => r.userId === String(alice._id));
  assert.ok(aliceRow.lastMessage.media, 'lastMessage must carry media for the Photo preview');
});

// --- Socket chat-message with media ---

test('socket chat-message with media persists it and broadcasts it with the media field', async (t) => {
  if (skipIfNoMongo(t)) return;
  const up = await upload(aliceJar, { buffer: PNG_1X1, filename: 'socket.png' });
  assert.equal(up.status, 201);
  // A real session token for Alice, so attachSocket's auth passes.
  const token = generateToken();
  await Session.create({ userId: alice._id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600e3) });
  const delivered = [];
  const handlers = {};
  let middleware = null;
  const fakeIo = {
    use(fn) { middleware = fn; },
    on(event, fn) { handlers[event] = fn; },
    emit() {},
    to(id) { return { emit: (event, payload) => delivered.push({ to: id, event, payload }) }; }
  };
  attachSocket(fakeIo);
  const socketHandlers = {};
  const fakeSocket = {
    id: 'sock-media-1',
    handshake: { headers: { cookie: `sessionToken=${token}` } },
    on(event, fn) { socketHandlers[event] = fn; },
    emit() {},
    join() {},
    leave() {},
    to() { return { emit() {} }; }
  };
  await new Promise((resolve, reject) => {
    middleware(fakeSocket, (err) => (err ? reject(err) : resolve()));
  });
  assert.ok(handlers.connection, 'connection handler must be registered');
  handlers.connection(fakeSocket);
  assert.ok(socketHandlers['chat-message'], 'chat-message handler must be registered');
  socketHandlers['chat-message']({
    roomId: String(publicRoom.id),
    text: 'from the socket',
    media: { url: up.body.url, type: 'image', name: 'socket.png' }
  });
  // The handler is async — wait for the write + broadcast.
  for (let i = 0; i < 50; i++) {
    if (delivered.length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const broadcast = delivered.find((d) => d.event === 'chat-message' && d.to === String(publicRoom.id));
  assert.ok(broadcast, 'chat-message must be broadcast to the room');
  assert.equal(broadcast.payload.text, 'from the socket');
  assert.equal(broadcast.payload.media.url, up.body.url);
  const stored = await Message.findOne({ _id: broadcast.payload.id }).lean();
  assert.ok(stored, 'socket message must be persisted');
  assert.equal(stored.media.url, up.body.url);
  assert.ok(stored.expireAt, 'socket message must carry fading-chat expiry');
  // Restore the real socket.io instance for any later tests.
  const { io } = require('../server');
  attachSocket(io);
});

// --- Unfurl ---

test('unfurl: invalid URLs 400; a cached preview is returned without fetching; unauthenticated 401', async (t) => {
  if (skipIfNoMongo(t)) return;
  const bad = await http('POST', '/api/unfurl', { jar: aliceJar, body: { url: 'ftp://example.com/x' } });
  assert.equal(bad.status, 400);
  // A CSRF token but no session: the 401 must come from auth, not CSRF.
  const anonJar = {};
  const csrf = await http('GET', '/api/auth/csrf-token', { jar: anonJar });
  anonJar.csrfToken = csrf.body.csrfToken;
  const anon = await http('POST', '/api/unfurl', { jar: anonJar, body: { url: 'https://example.com/' } });
  assert.equal(anon.status, 401);
  await LinkPreview.create({
    url: 'https://example.com/cached-page',
    title: 'Cached Title', description: 'Cached description',
    image: 'https://example.com/cached.png', favicon: 'https://example.com/favicon.ico',
    fetchedAt: new Date()
  });
  const cached = await http('POST', '/api/unfurl', { jar: aliceJar, body: { url: 'https://example.com/cached-page' } });
  assert.equal(cached.status, 200);
  assert.equal(cached.body.title, 'Cached Title');
  assert.equal(cached.body.description, 'Cached description');
  assert.equal(cached.body.image, 'https://example.com/cached.png');
});

// --- Media TTL index ---

test('ensureMediaIndexes creates the TTL index that fades stored images', async (t) => {
  if (skipIfNoMongo(t)) return;
  await ensureMediaIndexes(mongoose.connection.db);
  const indexes = await mongoose.connection.db.collection('media.files').listIndexes().toArray();
  const ttl = indexes.find((ix) => ix.name === 'media_expireAt_ttl');
  assert.ok(ttl, 'media_expireAt_ttl index must exist');
  assert.equal(ttl.expireAfterSeconds, 0);
  assert.deepEqual(ttl.key, { 'metadata.expireAt': 1 });
});
