// Tests for the room cap (v0.7.0): at most 8 live occupants per room.
//
// Three layers, following the suite's existing patterns:
//   - Pure/lib tests (always run): the cap constant, the friendly
//     message, and isRoomFull against the presence registry.
//   - Socket tests (always run): join-room through attachSocket with a
//     fake io and fake sockets — no MongoDB, no real socket.io server
//     (see tests/signalRelay.test.js). Room.findById is stubbed.
//   - HTTP tests (need MongoDB): POST /api/rooms/:id/join against the
//     real Express app. When no MongoDB is reachable they skip instead
//     of failing (see tests/emailVerification.test.js). Run a local
//     mongod (or set MONGODB_URI) to exercise them.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const presence = require('../lib/presence');
const { MAX_ROOM_OCCUPANTS, ROOM_FULL_MESSAGE, isRoomFull } = require('../lib/roomCap');
const Room = require('../models/Room');
const User = require('../models/User');
const { hashPassword, newSalt } = require('../lib/passwords');
const { attachSocket } = require('../lib/socket');
const apiRoutes = require('../routes/api');

const ROOM_ID = 'room-cap-1';
const OWNER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const uid = (i) => String(i).padStart(24, '0');
const publicRoom = { _id: ROOM_ID, isPrivate: false, members: [], createdBy: OWNER_ID };
const privateRoomOwnerOnly = {
  _id: ROOM_ID, isPrivate: true,
  members: [{ user: OWNER_ID, role: 'owner' }],
  createdBy: OWNER_ID
};

// --- Pure/lib tests ---

test('room cap is 8, the top of the 6-8 mesh range', () => {
  assert.equal(MAX_ROOM_OCCUPANTS, 8);
});

test('room-full message is friendly and names the cap, not a bare code', () => {
  assert.match(ROOM_FULL_MESSAGE, /full/i);
  assert.match(ROOM_FULL_MESSAGE, /8 people/);
  assert.match(ROOM_FULL_MESSAGE, /when someone leaves/i);
});

test('isRoomFull: false below the cap, true at it', () => {
  presence.clearAll();
  for (let i = 1; i <= 7; i += 1) {
    presence.addOccupant(ROOM_ID, `s${i}`, { id: uid(i), name: `U${i}` });
    assert.equal(isRoomFull(ROOM_ID), false, `should not be full at ${i}`);
  }
  presence.addOccupant(ROOM_ID, 's8', { id: uid(8), name: 'U8' });
  assert.equal(isRoomFull(ROOM_ID), true);
  assert.equal(presence.occupancyCount(ROOM_ID), 8);
  presence.clearAll();
});

test('isRoomFull: a socket already in the room does not count itself', () => {
  presence.clearAll();
  for (let i = 1; i <= 8; i += 1) {
    presence.addOccupant(ROOM_ID, `s${i}`, { id: uid(i), name: `U${i}` });
  }
  assert.equal(isRoomFull(ROOM_ID), true);
  // Rejoining the same socket must not be refused as the 9th person.
  assert.equal(isRoomFull(ROOM_ID, 's8'), false);
  assert.equal(isRoomFull(ROOM_ID, 's-not-here'), true);
  presence.clearAll();
});

test('isRoomFull: leaving frees the slot immediately', () => {
  presence.clearAll();
  for (let i = 1; i <= 8; i += 1) {
    presence.addOccupant(ROOM_ID, `s${i}`, { id: uid(i), name: `U${i}` });
  }
  assert.equal(isRoomFull(ROOM_ID), true);
  presence.removeOccupant(ROOM_ID, 's1');
  assert.equal(isRoomFull(ROOM_ID), false);
  assert.equal(presence.occupancyCount(ROOM_ID), 7);
  presence.clearAll();
});

// --- Socket tests (fake io, no MongoDB) ---

const originalFindById = Room.findById;
let roomDoc = publicRoom;

const stubRoom = (doc) => {
  roomDoc = doc;
  Room.findById = () => ({ lean: async () => roomDoc });
};

afterEach(() => {
  Room.findById = originalFindById;
  presence.clearAll();
});

const makeFakeIo = () => {
  const delivered = []; // { to, event, payload } — io.to(room).emit
  const handlers = {};
  return {
    delivered,
    handlers,
    use() {},
    on(event, fn) { handlers[event] = fn; },
    emit() {},
    to(id) {
      return {
        emit: (event, payload) => delivered.push({ to: id, event, payload })
      };
    }
  };
};

const makeFakeSocket = (id, userId) => {
  const handlers = {};
  const emitted = []; // events the server sent this socket
  const joined = []; // socket.io rooms this socket joined
  return {
    id,
    user: { id: userId, name: `User-${userId.slice(0, 4)}` },
    handlers,
    emitted,
    joined,
    on(event, fn) { handlers[event] = fn; },
    emit(event, payload) { emitted.push({ event, payload }); },
    join(roomId) { joined.push(roomId); },
    leave() {},
    to() { return { emit() {} }; }
  };
};

// Wire one authenticated socket into attachSocket and return it plus
// the fake io. attachSocket replaces the module-level io on each call,
// so every test gets a fresh server.
const connectSocket = (id, userId) => {
  const io = makeFakeIo();
  attachSocket(io);
  const sock = makeFakeSocket(id, userId);
  io.handlers.connection(sock);
  return { io, sock };
};

const join = (sock, roomId = ROOM_ID) => sock.handlers['join-room']({ roomId });

test('socket: 8th occupant joins fine, 9th is refused with the friendly message', async () => {
  stubRoom(publicRoom);
  const sockets = [];
  for (let i = 1; i <= 8; i += 1) {
    const { sock } = connectSocket(`s${i}`, uid(i));
    sockets.push(sock);
    await join(sock);
    const state = sock.emitted.find((e) => e.event === 'room-state');
    assert.ok(state, `occupant ${i} should get room-state`);
    assert.equal(sock.joined.length, 1, `occupant ${i} should join the io room`);
    assert.equal(sock.emitted.filter((e) => e.event === 'error').length, 0);
  }
  assert.equal(presence.occupancyCount(ROOM_ID), 8);

  const { sock: ninth } = connectSocket('s9', uid(9));
  await join(ninth);
  const err = ninth.emitted.find((e) => e.event === 'error');
  assert.ok(err, '9th occupant should get an error event');
  assert.equal(err.payload.code, 'room-full');
  assert.equal(err.payload.error, ROOM_FULL_MESSAGE);
  assert.equal(ninth.emitted.filter((e) => e.event === 'room-state').length, 0);
  assert.deepEqual(ninth.joined, [], '9th socket must not join the io room');
  assert.equal(presence.occupancyCount(ROOM_ID), 8, 'refused joiner must not be counted');
});

test('socket: the room owner is NOT exempt from the cap', async () => {
  stubRoom(publicRoom);
  for (let i = 1; i <= 8; i += 1) {
    const { sock } = connectSocket(`s${i}`, uid(i));
    await join(sock);
  }
  const { sock: owner } = connectSocket('s-owner', OWNER_ID);
  await join(owner);
  const err = owner.emitted.find((e) => e.event === 'error');
  assert.ok(err, 'owner as 9th should be refused');
  assert.equal(err.payload.code, 'room-full');
  assert.equal(presence.occupancyCount(ROOM_ID), 8);
});

test('socket: rejoining the same socket does not double-count or refuse', async () => {
  stubRoom(publicRoom);
  const first = [];
  for (let i = 1; i <= 8; i += 1) {
    const { sock } = connectSocket(`s${i}`, uid(i));
    first.push(sock);
    await join(sock);
  }
  // Socket s8 emits join-room again (client remount / retry): it is
  // already an occupant, so the cap must not count it twice.
  await join(first[7]);
  const states = first[7].emitted.filter((e) => e.event === 'room-state');
  assert.equal(states.length, 2, 'rejoin should get room-state again');
  assert.equal(first[7].emitted.filter((e) => e.event === 'error').length, 0);
  assert.equal(presence.occupancyCount(ROOM_ID), 8);
});

test('socket: leaving frees the slot for the next joiner', async () => {
  stubRoom(publicRoom);
  const sockets = [];
  for (let i = 1; i <= 8; i += 1) {
    const { sock } = connectSocket(`s${i}`, uid(i));
    sockets.push(sock);
    await join(sock);
  }
  sockets[0].handlers['leave-room']({ roomId: ROOM_ID });
  assert.equal(presence.occupancyCount(ROOM_ID), 7);
  const { sock: ninth } = connectSocket('s9', uid(9));
  await join(ninth);
  assert.ok(ninth.emitted.find((e) => e.event === 'room-state'), '9th should join after a leave');
  assert.equal(ninth.emitted.filter((e) => e.event === 'error').length, 0);
  assert.equal(presence.occupancyCount(ROOM_ID), 8);
});

test('socket: disconnect frees the slot for the next joiner', async () => {
  stubRoom(publicRoom);
  const sockets = [];
  for (let i = 1; i <= 8; i += 1) {
    const { sock } = connectSocket(`s${i}`, uid(i));
    sockets.push(sock);
    await join(sock);
  }
  sockets[0].handlers.disconnect();
  assert.equal(presence.occupancyCount(ROOM_ID), 7);
  const { sock: ninth } = connectSocket('s9', uid(9));
  await join(ninth);
  assert.ok(ninth.emitted.find((e) => e.event === 'room-state'), '9th should join after a disconnect');
  assert.equal(presence.occupancyCount(ROOM_ID), 8);
});

test('socket: cap is checked after the private-room gate (non-member hears "private", not "full")', async () => {
  stubRoom(privateRoomOwnerOnly);
  for (let i = 1; i <= 8; i += 1) {
    // Owner-only private room: seed presence directly, since only the
    // owner could join through the handler.
    presence.addOccupant(ROOM_ID, `s${i}`, { id: i === 1 ? OWNER_ID : uid(i), name: `U${i}` });
  }
  const { sock: stranger } = connectSocket('s9', uid(9));
  await join(stranger);
  const err = stranger.emitted.find((e) => e.event === 'error');
  assert.ok(err);
  assert.equal(err.payload.error, 'This room is private');
  assert.equal(err.payload.code, undefined);
});

// --- HTTP tests ---

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit-test-room-cap';
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

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    mongoAvailable = true;
    await mongoose.connection.db.dropDatabase();
    const { app } = require('../server');
    server = await listen(app);
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
  presence.clearAll();
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

const makePasswordUser = async ({ email, name }) => {
  const salt = newSalt();
  return User.create({
    email, name, passwordSalt: salt,
    passwordHash: hashPassword('correct-horse-battery-stable', salt),
    emailVerified: true
  });
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

// Seed live presence for a room: `count` fake occupants.
const seedPresence = (roomId, count, startAt = 1) => {
  presence.clearAll();
  for (let i = 0; i < count; i += 1) {
    presence.addOccupant(String(roomId), `seed-${startAt + i}`, { id: uid(startAt + i), name: `Seed${startAt + i}` });
  }
};

test('HTTP: POST /api/rooms/:id/join exists — no auth is 401, not 404', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  const s = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/rooms/${new mongoose.Types.ObjectId()}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 401);
  } finally {
    s.close();
  }
});

test('HTTP: 9th person gets 409 with the friendly message', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser({ email: 'ninth@orbit.test', name: 'Ninth' });
  const room = await Room.create({ name: 'Cap Room', createdBy: user._id });
  seedPresence(room._id, 8);
  const { jar } = await login('ninth@orbit.test');
  await bootstrapCsrf(jar);
  const res = await http('POST', `/api/rooms/${room._id}/join`, { jar, body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'room-full');
  assert.equal(res.body.error, ROOM_FULL_MESSAGE);
  presence.clearAll();
});

test('HTTP: 8th person gets 200 with the room', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser({ email: 'eighth@orbit.test', name: 'Eighth' });
  const room = await Room.create({ name: 'Cap Room 2', createdBy: user._id });
  seedPresence(room._id, 7);
  const { jar } = await login('eighth@orbit.test');
  await bootstrapCsrf(jar);
  const res = await http('POST', `/api/rooms/${room._id}/join`, { jar, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, String(room._id));
  assert.equal(res.body.occupantCount, 7);
  presence.clearAll();
});

test('HTTP: owner as 9th gets 409 too — no exemption', async (t) => {
  if (skipIfNoMongo(t)) return;
  const owner = await makePasswordUser({ email: 'owner@orbit.test', name: 'Owner' });
  const room = await Room.create({ name: 'Cap Room 3', createdBy: owner._id });
  seedPresence(room._id, 8);
  const { jar } = await login('owner@orbit.test');
  await bootstrapCsrf(jar);
  const res = await http('POST', `/api/rooms/${room._id}/join`, { jar, body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'room-full');
  presence.clearAll();
});

test('HTTP: faded campfire reads as 404, not 409', async (t) => {
  if (skipIfNoMongo(t)) return;
  const user = await makePasswordUser({ email: 'faded@orbit.test', name: 'Faded' });
  const room = await Room.create({
    name: 'Faded', createdBy: user._id,
    ephemeral: true, expiresAt: new Date(Date.now() - 1000)
  });
  seedPresence(room._id, 8);
  const { jar } = await login('faded@orbit.test');
  await bootstrapCsrf(jar);
  const res = await http('POST', `/api/rooms/${room._id}/join`, { jar, body: {} });
  assert.equal(res.status, 404);
  presence.clearAll();
});

test('HTTP: private room a non-member cannot see is 403, even when full', async (t) => {
  if (skipIfNoMongo(t)) return;
  const owner = await makePasswordUser({ email: 'priv-owner@orbit.test', name: 'PrivOwner' });
  const stranger = await makePasswordUser({ email: 'priv-stranger@orbit.test', name: 'Stranger' });
  const room = await Room.create({
    name: 'Private', createdBy: owner._id, isPrivate: true,
    members: [{ user: owner._id, role: 'owner' }]
  });
  seedPresence(room._id, 8);
  const { jar } = await login('priv-stranger@orbit.test');
  await bootstrapCsrf(jar);
  const res = await http('POST', `/api/rooms/${room._id}/join`, { jar, body: {} });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'This room is private');
  presence.clearAll();
});
