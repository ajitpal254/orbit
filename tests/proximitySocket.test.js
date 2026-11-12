// Tests for the server side of proximity audio (v0.6.0):
//  - lib/proximity.js position validation / clamping
//  - the `orb-move` relay in lib/socket.js: membership rejection
//    (same H1 pattern as the signal relay — presence + canSeeRoom),
//    clamping applied, wrong-room and invalid payloads dropped,
//    and movement rate-limiting.
//
// Driven end to end through attachSocket with a fake io and fake
// sockets — no MongoDB, no real socket.io server. Presence is seeded
// directly (the same way join-room would seed it); Room.findById is
// stubbed to return canned room docs, and restored after each test.
// (Harness mirrors tests/signalRelay.test.js.)
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const presence = require('../lib/presence');
const Room = require('../models/Room');
const { attachSocket } = require('../lib/socket');
const { validatePosition } = require('../lib/proximity');

const VICTIM_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ATTACKER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const privateRoomBothMembers = {
  _id: 'room1', isPrivate: true,
  members: [{ user: VICTIM_ID, role: 'owner' }, { user: ATTACKER_ID, role: 'member' }],
  createdBy: VICTIM_ID
};
const privateRoomVictimOnly = {
  _id: 'room1', isPrivate: true,
  members: [{ user: VICTIM_ID, role: 'owner' }],
  createdBy: VICTIM_ID
};
const publicRoom = { _id: 'room1', isPrivate: false, members: [], createdBy: VICTIM_ID };

const originalFindById = Room.findById;
let roomById = {};

const stubRooms = (docs) => {
  roomById = docs;
  Room.findById = (id) => ({ lean: async () => roomById[String(id)] || null });
};

afterEach(() => {
  Room.findById = originalFindById;
  presence.clearAll();
});

// Fake socket.io server: captures the connection handler and every
// relayed emit (both io.to(id) and socket.to(room) broadcasts).
const makeFakeIo = () => {
  const delivered = []; // { to, event, payload }
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

const makeFakeSocket = (id, userId, delivered) => {
  const handlers = {};
  return {
    id,
    user: { id: userId, name: `User-${userId.slice(0, 4)}` },
    handlers,
    on(event, fn) { handlers[event] = fn; },
    emit() {},
    join() {},
    leave() {},
    to(roomId) {
      return {
        emit: (event, payload) => delivered.push({ to: roomId, event, payload })
      };
    }
  };
};

const connectPair = () => {
  const io = makeFakeIo();
  attachSocket(io);
  const victim = makeFakeSocket('sock-victim', VICTIM_ID, io.delivered);
  const attacker = makeFakeSocket('sock-attacker', ATTACKER_ID, io.delivered);
  io.handlers.connection(victim);
  io.handlers.connection(attacker);
  return { io, victim, attacker };
};

const move = (sock, payload) => sock.handlers['orb-move'](payload);

// --- lib/proximity.js: validation + clamping ---

test('validatePosition: accepts in-range numbers unchanged', () => {
  assert.deepEqual(validatePosition({ x: 50, y: 46 }), { ok: true, x: 50, y: 46 });
  assert.deepEqual(validatePosition({ x: 0, y: 100 }), { ok: true, x: 0, y: 100 });
});

test('validatePosition: clamps out-of-range coordinates into the room', () => {
  assert.deepEqual(validatePosition({ x: 150, y: -30 }), { ok: true, x: 100, y: 0 });
  assert.deepEqual(validatePosition({ x: -1, y: 1000 }), { ok: true, x: 0, y: 100 });
});

test('validatePosition: rejects non-numbers, NaN, Infinity and missing fields', () => {
  for (const bad of [
    { x: '50', y: 46 }, { x: 50, y: '46' }, { x: NaN, y: 46 },
    { x: 50, y: Infinity }, { x: 50 }, { y: 46 }, {}, null, undefined,
    { x: null, y: 46 }, { x: 50, y: null }
  ]) {
    assert.deepEqual(validatePosition(bad), { ok: false, x: null, y: null }, JSON.stringify(bad));
  }
});

// --- orb-move relay ---

test('orb-move: a member move is relayed to the room with clamped coords', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  await move(attacker, { roomId: 'room1', x: 150, y: -20 });
  assert.equal(io.delivered.length, 1);
  assert.deepEqual(io.delivered[0], {
    to: 'room1',
    event: 'orb-move',
    payload: { socketId: 'sock-attacker', userId: ATTACKER_ID, x: 100, y: 0 }
  });
});

test('orb-move: a plain in-range move relays unchanged', async () => {
  stubRooms({ room1: publicRoom });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  await move(attacker, { roomId: 'room1', x: 42.5, y: 61 });
  assert.equal(io.delivered.length, 1);
  assert.equal(io.delivered[0].payload.x, 42.5);
  assert.equal(io.delivered[0].payload.y, 61);
});

test('orb-move: a socket that never joined a room cannot move in it', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  const { io, attacker } = connectPair();
  await move(attacker, { roomId: 'room1', x: 50, y: 50 });
  assert.deepEqual(io.delivered, []);
});

test('orb-move: a kicked non-member with stale presence cannot move', async () => {
  stubRooms({ room1: privateRoomVictimOnly });
  // Same backstop as the H1 signal relay: presence alone would allow
  // the move, but the room's member list refuses a kicked socket.
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  await move(attacker, { roomId: 'room1', x: 50, y: 50 });
  assert.deepEqual(io.delivered, []);
});

test('orb-move: a payload naming a different room than the socket is in is dropped', async () => {
  stubRooms({ room1: privateRoomBothMembers, room2: publicRoom });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  presence.addOccupant('room2', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  const { io, attacker } = connectPair();
  await move(attacker, { roomId: 'room2', x: 50, y: 50 });
  assert.deepEqual(io.delivered, []);
});

test('orb-move: invalid coordinates are dropped, not relayed or coerced', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  for (const bad of [
    { roomId: 'room1', x: '50', y: 50 },
    { roomId: 'room1', x: NaN, y: 50 },
    { roomId: 'room1', x: 50, y: Infinity },
    { roomId: 'room1' }
  ]) {
    await move(attacker, bad);
  }
  assert.deepEqual(io.delivered, []);
});

test('orb-move: a faded campfire takes no more moves', async () => {
  const faded = {
    ...privateRoomBothMembers,
    ephemeral: true,
    expiresAt: new Date(Date.now() - 1000)
  };
  stubRooms({ room1: faded });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  await move(attacker, { roomId: 'room1', x: 50, y: 50 });
  assert.deepEqual(io.delivered, []);
});

test('orb-move: movement is rate-limited — the 21st move in a burst drops', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  for (let i = 0; i < 20; i++) {
    await move(attacker, { roomId: 'room1', x: 50 + i, y: 50 });
  }
  assert.equal(io.delivered.length, 20);
  await move(attacker, { roomId: 'room1', x: 90, y: 50 });
  assert.equal(io.delivered.length, 20, 'over-limit move dropped, not relayed');
});
