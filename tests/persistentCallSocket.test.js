// Tests for the persistent-call server contract (v0.9.0):
//   - disconnect arms a 15s grace: no user-left until it elapses;
//   - reconnect-to-room within the grace cancels it and swaps the
//     socket (user-left for the dead socket + user-joined for the new
//     one, room-state to the reconnecting socket, no second departure);
//   - the leave-beacon (confirmTabClose) departs at once, idempotently.
//   - leave-room cancels a pending grace.
//
// Driven end to end through attachSocket with a fake io and fake
// sockets — no MongoDB, no real socket.io server. Presence is seeded
// directly; Room.findById is stubbed to return canned room docs.
// (Harness mirrors tests/screenShareSocket.test.js.) Two occupants
// are always seeded so occupancy never hits 0 — the campfire fade
// (armExpiry, a real DB write) never fires here. The grace is
// shortened to 50ms via the _setDisconnectGraceMsForTests seam.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const presence = require('../lib/presence');
const Room = require('../models/Room');
const {
  attachSocket, clearScreenShares, confirmTabClose, _setDisconnectGraceMsForTests
} = require('../lib/socket');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  Room.findById = originalFindById;
  presence.clearAll();
  clearScreenShares();
  _setDisconnectGraceMsForTests(15000);
});

// Fake socket.io server: captures the connection handler and every
// relayed emit (both io.to(id) and socket.to(room) broadcasts, plus
// io-level broadcasts like rooms-changed).
const makeFakeIo = () => {
  const delivered = []; // { to, event, payload }
  const broadcast = []; // { event, payload } via io.emit
  const handlers = {};
  return {
    delivered,
    broadcast,
    handlers,
    use() {},
    on(event, fn) { handlers[event] = fn; },
    emit(event, payload) { broadcast.push({ event, payload }); },
    to(id) {
      return {
        emit: (event, payload) => delivered.push({ to: id, event, payload })
      };
    }
  };
};

const makeFakeSocket = (id, userId) => {
  const handlers = {};
  const emitted = []; // direct socket.emit calls (errors, room-state)
  return {
    id,
    user: { id: userId, name: `User-${userId.slice(0, 4)}` },
    handlers,
    emitted,
    on(event, fn) { handlers[event] = fn; },
    emit(event, payload) { emitted.push({ event, payload }); },
    join() {},
    leave() {},
    to(roomId) {
      return {
        emit: (event, payload) => { /* replaced per-test via io */ }
      };
    }
  };
};

// The fake socket's .to() must route into the fake io's delivered
// list (the real socket.io does that); wire it up after connect.
const connectPair = () => {
  const io = makeFakeIo();
  attachSocket(io);
  const victim = makeFakeSocket('sock-victim', VICTIM_ID);
  const attacker = makeFakeSocket('sock-attacker', ATTACKER_ID);
  for (const s of [victim, attacker]) {
    s.to = (roomId) => ({
      emit: (event, payload) => io.delivered.push({ to: roomId, event, payload })
    });
  }
  io.handlers.connection(victim);
  io.handlers.connection(attacker);
  return { io, victim, attacker };
};

const connectSocket = (io, id, userId) => {
  const sock = makeFakeSocket(id, userId);
  sock.to = (roomId) => ({
    emit: (event, payload) => io.delivered.push({ to: roomId, event, payload })
  });
  io.handlers.connection(sock);
  return sock;
};

// Both sockets in room1 (presence), so a departure never empties it.
const seedRoom = () => {
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'User-aaaa' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'User-bbbb' });
};

const userLeftFor = (io, socketId) =>
  io.delivered.filter((d) => d.to === 'room1' && d.event === 'user-left' && d.payload.socketId === socketId);
const userJoinedFor = (io, socketId) =>
  io.delivered.filter((d) => d.to === 'room1' && d.event === 'user-joined' && d.payload.socketId === socketId);

// --- disconnect grace -------------------------------------------------------

test('disconnect arms the grace: presence drops at once, user-left waits', async () => {
  _setDisconnectGraceMsForTests(50);
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  victim.handlers.disconnect();
  // Presence is socket truth: the dead socket is gone immediately.
  assert.equal(presence.occupancyCount('room1'), 1);
  assert.deepEqual(userLeftFor(io, 'sock-victim'), [], 'no departure announced inside the grace');
  await sleep(100);
  const left = userLeftFor(io, 'sock-victim');
  assert.equal(left.length, 1, 'the departure fires once the grace elapses');
  assert.deepEqual(left[0].payload, { socketId: 'sock-victim', userId: VICTIM_ID });
  assert.ok(
    io.broadcast.some((b) => b.event === 'rooms-changed'),
    'rooms-changed fires with the deferred departure'
  );
});

test('a second disconnect in the same room merges into one grace entry', async () => {
  _setDisconnectGraceMsForTests(50);
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  // A second socket of the same user in the same room.
  const victim2 = connectSocket(io, 'sock-victim-2', VICTIM_ID);
  presence.addOccupant('room1', 'sock-victim-2', { id: VICTIM_ID, name: 'User-aaaa' });
  victim.handlers.disconnect();
  victim2.handlers.disconnect();
  await sleep(100);
  assert.equal(userLeftFor(io, 'sock-victim').length, 1);
  assert.equal(userLeftFor(io, 'sock-victim-2').length, 1);
  assert.equal(presence.occupancyCount('room1'), 1, 'only the attacker remains');
  void attacker;
});

// --- reconnect-to-room --------------------------------------------------------

test('reconnect within the grace cancels it and swaps the socket', async () => {
  _setDisconnectGraceMsForTests(50);
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  victim.handlers.disconnect();
  assert.deepEqual(userLeftFor(io, 'sock-victim'), [], 'nothing announced yet');
  // The same user comes back on a new socket (a real reconnect always
  // gets a new socket id).
  const fresh = connectSocket(io, 'sock-victim-new', VICTIM_ID);
  await fresh.handlers['reconnect-to-room']({ roomId: 'room1' });
  // The dead socket's departure fires at once (the swap), and the new
  // socket joins — no waiting out the grace.
  assert.equal(userLeftFor(io, 'sock-victim').length, 1, 'old socket departs now');
  assert.equal(userJoinedFor(io, 'sock-victim-new').length, 1, 'new socket joins');
  const roomState = fresh.emitted.find((e) => e.event === 'room-state');
  assert.ok(roomState, 'the reconnecting socket gets room-state');
  assert.deepEqual(
    roomState.payload.occupants.map((o) => o.socketId),
    ['sock-attacker'],
    'room-state lists the other occupant, not self'
  );
  assert.equal(presence.occupancyCount('room1'), 2, 'presence restored');
  // The cancelled grace never fires a second departure.
  await sleep(100);
  assert.equal(userLeftFor(io, 'sock-victim').length, 1);
  assert.equal(userLeftFor(io, 'sock-victim-new').length, 0);
});

test('reconnect-to-room refuses a room I cannot see', async () => {
  _setDisconnectGraceMsForTests(50);
  stubRooms({ room1: privateRoomVictimOnly });
  const { io, attacker } = connectPair();
  seedRoom();
  attacker.handlers.disconnect();
  const fresh = connectSocket(io, 'sock-attacker-new', ATTACKER_ID);
  await fresh.handlers['reconnect-to-room']({ roomId: 'room1' });
  const err = fresh.emitted.find((e) => e.event === 'error');
  assert.ok(err);
  assert.equal(err.payload.error, 'This room is private');
  assert.equal(userJoinedFor(io, 'sock-attacker-new').length, 0);
  // The grace still settles the dead socket (the refusal is about the
  // rejoin, not the departure).
  await sleep(100);
  assert.equal(userLeftFor(io, 'sock-attacker').length, 1);
});

test('reconnect-to-room with no room id is a silent no-op', async () => {
  _setDisconnectGraceMsForTests(50);
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  victim.handlers.disconnect();
  const fresh = connectSocket(io, 'sock-victim-new', VICTIM_ID);
  await fresh.handlers['reconnect-to-room']({});
  assert.equal(fresh.emitted.length, 0);
  assert.equal(userJoinedFor(io, 'sock-victim-new').length, 0);
});

// --- leave-beacon (confirmTabClose) -------------------------------------------

test('leave-beacon departs at once and is idempotent', async () => {
  stubRooms({ room1: publicRoom });
  const { io } = connectPair();
  seedRoom();
  assert.equal(confirmTabClose(VICTIM_ID, 'room1'), true, 'first beacon departs');
  assert.equal(userLeftFor(io, 'sock-victim').length, 1, 'departure fires immediately, no grace');
  assert.equal(presence.occupancyCount('room1'), 1);
  assert.equal(confirmTabClose(VICTIM_ID, 'room1'), false, 'second beacon is a no-op');
  assert.equal(userLeftFor(io, 'sock-victim').length, 1, 'no duplicate departure');
  assert.equal(confirmTabClose('ffffffffffffffffffffffff', 'room1'), false, 'a stranger departs nothing');
});

test('leave-beacon settles a pending grace instead of waiting it out', async () => {
  _setDisconnectGraceMsForTests(50);
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  victim.handlers.disconnect();
  assert.deepEqual(userLeftFor(io, 'sock-victim'), [], 'grace pending, nothing yet');
  assert.equal(confirmTabClose(VICTIM_ID, 'room1'), true, 'beacon fires the departure now');
  assert.equal(userLeftFor(io, 'sock-victim').length, 1);
  await sleep(100);
  assert.equal(userLeftFor(io, 'sock-victim').length, 1, 'the cancelled grace never fires again');
});

// --- leave-room cancels the grace --------------------------------------------

test('explicit leave-room cancels a pending grace', async () => {
  _setDisconnectGraceMsForTests(50);
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  victim.handlers.disconnect();
  victim.handlers['leave-room']({ roomId: 'room1' });
  assert.equal(userLeftFor(io, 'sock-victim').length, 1, 'the explicit leave announces at once');
  await sleep(100);
  assert.equal(userLeftFor(io, 'sock-victim').length, 1, 'no second announcement from the grace');
});
