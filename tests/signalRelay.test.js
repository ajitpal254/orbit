// Regression tests for audit H1: the server-side room check on the
// `signal` relay (lib/socket.js), plus the roomOfSocket helper it uses.
// The relay is driven end to end through attachSocket with a fake io and
// fake sockets — no MongoDB, no real socket.io server. Presence is seeded
// directly (the same way join-room would seed it); Room.findById is
// stubbed to return canned room docs, and restored after each test.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const presence = require('../lib/presence');
const Room = require('../models/Room');
const { attachSocket } = require('../lib/socket');

const VICTIM_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ATTACKER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_ID = 'cccccccccccccccccccccccc';

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
let findByIdCalls = 0;

const stubRooms = (docs) => {
  roomById = docs;
  findByIdCalls = 0;
  Room.findById = (id) => {
    findByIdCalls += 1;
    return { lean: async () => roomById[String(id)] || null };
  };
};

afterEach(() => {
  Room.findById = originalFindById;
  presence.clearAll();
});

// Fake socket.io server: captures the connection handler and every
// relayed emit. The auth middleware is never invoked — the test calls
// the connection handler directly with an already-authenticated socket.
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

const makeFakeSocket = (id, userId) => {
  const handlers = {};
  return {
    id,
    user: { id: userId, name: `User-${userId.slice(0, 4)}` },
    handlers,
    on(event, fn) { handlers[event] = fn; },
    emit() {},
    join() {},
    leave() {},
    to() { return { emit() {} }; }
  };
};

// Wire two sockets into attachSocket and return their signal handlers.
const connectPair = () => {
  const io = makeFakeIo();
  attachSocket(io);
  const victim = makeFakeSocket('sock-victim', VICTIM_ID);
  const attacker = makeFakeSocket('sock-attacker', ATTACKER_ID);
  io.handlers.connection(victim);
  io.handlers.connection(attacker);
  return { io, victim, attacker };
};

const signal = (sock, to, type = 'offer') =>
  sock.handlers.signal({ to, type, data: { type, sdp: 'fake' } });

test('presence.roomOfSocket: which room a socket is in', () => {
  presence.clearAll();
  presence.addOccupant('room1', 'sock-a', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room2', 'sock-b', { id: ATTACKER_ID, name: 'Att' });
  assert.equal(presence.roomOfSocket('sock-a'), 'room1');
  assert.equal(presence.roomOfSocket('sock-b'), 'room2');
  assert.equal(presence.roomOfSocket('sock-nope'), null);
  presence.removeSocketEverywhere('sock-a');
  assert.equal(presence.roomOfSocket('sock-a'), null);
  presence.clearAll();
});

test('H1: a socket that never joined a room cannot signal a room occupant', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  // Victim is in room1; the attacker never joined anything — the exact
  // hole in the audit (the relay used to forward to any socket id).
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  const { io, attacker } = connectPair();
  await signal(attacker, 'sock-victim');
  assert.deepEqual(io.delivered, []);
  // The presence check short-circuits before any DB lookup.
  assert.equal(findByIdCalls, 0);
});

test('H1: a socket in a different room cannot signal across rooms', async () => {
  stubRooms({ room1: privateRoomBothMembers, room2: publicRoom });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room2', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  await signal(attacker, 'sock-victim');
  assert.deepEqual(io.delivered, []);
});

test('H1: a kicked non-member with stale presence cannot signal the room', async () => {
  stubRooms({ room1: privateRoomVictimOnly });
  // The attacker is still in presence (their client never emitted
  // leave-room after the kick) — presence alone would allow the relay.
  // The room's member list is the backstop: they are no longer a member.
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  await signal(attacker, 'sock-victim');
  assert.deepEqual(io.delivered, []);
  assert.equal(findByIdCalls, 1, 'the member-list check ran');
});

test('H1: two members of a private room can still signal each other', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, victim, attacker } = connectPair();
  await signal(attacker, 'sock-victim', 'offer');
  assert.equal(io.delivered.length, 1);
  assert.deepEqual(io.delivered[0], {
    to: 'sock-victim',
    event: 'signal',
    payload: { from: 'sock-attacker', type: 'offer', data: { type: 'offer', sdp: 'fake' } }
  });
  // The reverse direction works too: the victim answers the attacker.
  await signal(victim, 'sock-attacker', 'answer');
  assert.equal(io.delivered.length, 2);
  assert.deepEqual(io.delivered[1].payload, {
    from: 'sock-victim', type: 'answer', data: { type: 'answer', sdp: 'fake' }
  });
});

test('H1: occupants of a public room can signal each other', async () => {
  stubRooms({ room1: publicRoom });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  await signal(attacker, 'sock-victim', 'offer');
  assert.equal(io.delivered.length, 1);
});

test('H1: signaling a socket id that is in no room is dropped', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  // The sender IS a room member, but the target socket id is not in any
  // room (stale id learned from an old room-state, or a guess).
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  await signal(attacker, 'sock-ghost');
  assert.deepEqual(io.delivered, []);
});

test('H1: a faded campfire takes no more signals', async () => {
  const faded = {
    ...privateRoomBothMembers,
    ephemeral: true,
    expiresAt: new Date(Date.now() - 1000)
  };
  stubRooms({ room1: faded });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  await signal(attacker, 'sock-victim');
  assert.deepEqual(io.delivered, []);
});

test('M3 wiring: the 121st signal in a burst is dropped by the limiter', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'Vic' });
  presence.addOccupant('room1', 'sock-attacker', { id: ATTACKER_ID, name: 'Att' });
  const { io, attacker } = connectPair();
  for (let i = 0; i < 120; i++) await signal(attacker, 'sock-victim', 'ice');
  assert.equal(io.delivered.length, 120);
  await signal(attacker, 'sock-victim', 'ice');
  assert.equal(io.delivered.length, 120, 'over-limit signal dropped, not relayed');
});
