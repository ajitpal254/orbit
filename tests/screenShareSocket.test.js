// Tests for the server side of screen sharing (v0.8.0):
//   - the `screen-share-started` / `screen-share-stopped` relay in
//     lib/socket.js: the one-sharer rule (second claimant gets the
//     exact error "Someone is already sharing"), membership gating
//     (same H1 pattern as the signal relay — presence + canSeeRoom),
//     and auto-release on leave-room / disconnect.
//   - room-state carries the current sharer for late joiners.
//   - lib/screenShare.js itself is tests/screenShare.test.mjs.
//
// Driven end to end through attachSocket with a fake io and fake
// sockets — no MongoDB, no real socket.io server. Presence is seeded
// directly (the same way join-room would seed it); Room.findById is
// stubbed to return canned room docs, and restored after each test.
// (Harness mirrors tests/proximitySocket.test.js.)
// Two occupants are always seeded so occupancy never hits 0 — the
// campfire fade (armExpiry, a real DB write) never fires here.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const presence = require('../lib/presence');
const Room = require('../models/Room');
const { attachSocket, clearScreenShares, _setDisconnectGraceMsForTests } = require('../lib/socket');

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
  clearScreenShares();
  _setDisconnectGraceMsForTests(15000);
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

// Both sockets in room1 (presence), so leave/disconnect never empties it.
const seedRoom = () => {
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'User-aaaa' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'User-bbbb' });
};

const start = (sock, payload) => sock.handlers['screen-share-started'](payload);
const stop = (sock, payload) => sock.handlers['screen-share-stopped'](payload);
const roomBroadcasts = (io, event) =>
  io.delivered.filter((d) => d.to === 'room1' && d.event === event);

// --- claim + broadcast ------------------------------------------------------

test('first claim broadcasts screen-share-started to the room', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  await start(victim, { roomId: 'room1' });
  const broadcasts = roomBroadcasts(io, 'screen-share-started');
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0].payload, { userId: VICTIM_ID, name: 'User-aaaa', roomId: 'room1' });
  assert.equal(victim.emitted.length, 0); // no error to the claimant
});

test('second claimant gets exactly "Someone is already sharing" and no broadcast', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await start(victim, { roomId: 'room1' });
  await start(attacker, { roomId: 'room1' });
  assert.equal(roomBroadcasts(io, 'screen-share-started').length, 1);
  assert.equal(attacker.emitted.length, 1);
  assert.equal(attacker.emitted[0].event, 'error');
  assert.equal(attacker.emitted[0].payload.error, 'Someone is already sharing');
  assert.equal(attacker.emitted[0].payload.code, 'screen-share-busy');
});

test('same user re-claiming is idempotent — no error, one broadcast each time', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  await start(victim, { roomId: 'room1' });
  await start(victim, { roomId: 'room1' });
  assert.equal(roomBroadcasts(io, 'screen-share-started').length, 2);
  assert.equal(victim.emitted.length, 0);
});

// --- stop + re-claim ----------------------------------------------------------

test('holder stopping broadcasts, then someone else can claim', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await start(victim, { roomId: 'room1' });
  await stop(victim, { roomId: 'room1' });
  const stops = roomBroadcasts(io, 'screen-share-stopped');
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].payload, { userId: VICTIM_ID, roomId: 'room1' });
  await start(attacker, { roomId: 'room1' });
  assert.equal(roomBroadcasts(io, 'screen-share-started').length, 2);
  assert.equal(attacker.emitted.length, 0);
});

test('a non-holder stopping changes nothing — the share survives', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await start(victim, { roomId: 'room1' });
  await stop(attacker, { roomId: 'room1' });
  assert.equal(roomBroadcasts(io, 'screen-share-stopped').length, 0);
  // The slot is still held: a third claim is still refused. (The
  // attacker re-claiming is refused because the victim holds it.)
  await start(attacker, { roomId: 'room1' });
  assert.equal(attacker.emitted.length, 1);
  assert.equal(attacker.emitted[0].payload.error, 'Someone is already sharing');
});

// --- auto-release on leave / disconnect ---------------------------------------

test('leave-room releases the slot and broadcasts the stop', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await start(victim, { roomId: 'room1' });
  victim.handlers['leave-room']({ roomId: 'room1' });
  const stops = roomBroadcasts(io, 'screen-share-stopped');
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].payload, { userId: VICTIM_ID, roomId: 'room1' });
  // The slot is free again.
  await start(attacker, { roomId: 'room1' });
  assert.equal(attacker.emitted.length, 0);
});

test('disconnect releases the slot and broadcasts the stop — after the grace', async () => {
  // Disconnect grace (v0.9.0): a dropped socket is not a departure
  // until the grace elapses, so the share slot stays held inside the
  // window (a reconnecting sharer keeps it) and releases when the
  // grace fires. The 15s grace is shortened here via the test seam.
  _setDisconnectGraceMsForTests(50);
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await start(victim, { roomId: 'room1' });
  victim.handlers.disconnect();
  assert.equal(roomBroadcasts(io, 'screen-share-stopped').length, 0, 'no release inside the grace');
  await new Promise((r) => setTimeout(r, 100));
  const stops = roomBroadcasts(io, 'screen-share-stopped');
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].payload, { userId: VICTIM_ID, roomId: 'room1' });
  await start(attacker, { roomId: 'room1' });
  assert.equal(attacker.emitted.length, 0);
});

test('leave-room by a non-sharer broadcasts no stop', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await start(victim, { roomId: 'room1' });
  attacker.handlers['leave-room']({ roomId: 'room1' });
  assert.equal(roomBroadcasts(io, 'screen-share-stopped').length, 0);
});

// --- gating: presence + membership ---------------------------------------------

test('a socket that never joined cannot claim a slot (silent drop)', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  // The attacker leaves presence (simulating a socket that never
  // joined) but keeps its socket: the claim must go nowhere.
  presence.removeOccupant('room1', 'sock-attacker');
  presence.addOccupant('room1', 'sock-third', { id: 'cccccccccccccccccccccccc', name: 'Third' });
  await start(attacker, { roomId: 'room1' });
  assert.equal(roomBroadcasts(io, 'screen-share-started').length, 0);
  assert.equal(attacker.emitted.length, 0); // silent — a prober learns nothing
});

test('a non-member cannot claim in a private room even when present', async () => {
  stubRooms({ room1: privateRoomVictimOnly });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await start(attacker, { roomId: 'room1' });
  assert.equal(roomBroadcasts(io, 'screen-share-started').length, 0);
  assert.equal(attacker.emitted.length, 0);
  // The member can.
  await start(victim, { roomId: 'room1' });
  assert.equal(roomBroadcasts(io, 'screen-share-started').length, 1);
});

test('a claim naming a room the socket is not in is dropped', async () => {
  stubRooms({ room1: publicRoom, room2: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  await start(victim, { roomId: 'room2' });
  assert.equal(roomBroadcasts(io, 'screen-share-started').length, 0);
  assert.equal(victim.emitted.length, 0);
});

// --- room-state carries the sharer for late joiners ----------------------------

test('room-state tells a late joiner who is sharing', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  // Victim joins for real (join-room seeds presence + emits room-state).
  await victim.handlers['join-room']({ roomId: 'room1' });
  await start(victim, { roomId: 'room1' });
  // Attacker joins after the share started.
  await attacker.handlers['join-room']({ roomId: 'room1' });
  const states = attacker.emitted.filter((e) => e.event === 'room-state');
  assert.equal(states.length, 1);
  assert.deepEqual(states[0].payload.screenSharer, { userId: VICTIM_ID, name: 'User-aaaa' });
});

test('room-state carries no sharer when nobody is sharing', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  await victim.handlers['join-room']({ roomId: 'room1' });
  const states = victim.emitted.filter((e) => e.event === 'room-state');
  assert.equal(states.length, 1);
  assert.equal(states[0].payload.screenSharer, null);
});
