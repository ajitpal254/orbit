// Tests for the server side of the music bot (v0.10.0):
//   - the music-* events in lib/socket.js: the one-DJ rule, queue
//     add/remove, skip/play/pause/stop, role gates (DJ or owner/mod),
//     membership gating (same H1 pattern as the signal relay —
//     presence + canSeeRoom), and auto-release on leave-room /
//     disconnect.
//   - room-state hydration: a late joiner gets the full music-state.
//   - idle auto-disconnect: a lone DJ with active music gets
//     music-idle-warning then music-idle-disconnect + a fresh
//     music-state (dj null, queue kept); a listener joining cancels it.
//   - lib/musicQueue.js itself is tests/musicQueue.test.js,
//     lib/musicIdle.js is tests/musicIdle.test.js.
//
// Driven end to end through attachSocket with a fake io and fake
// sockets — no MongoDB, no real socket.io server. Presence is seeded
// directly (the same way join-room would seed it); Room.findById is
// stubbed to return canned room docs, and restored after each test.
// (Harness mirrors tests/screenShareSocket.test.js.)
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const presence = require('../lib/presence');
const Room = require('../models/Room');
const {
  attachSocket, clearScreenShares, clearAllMusic, _setMusicIdleForTests,
  _setDisconnectGraceMsForTests
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

afterEach(() => {
  Room.findById = originalFindById;
  presence.clearAll();
  clearScreenShares();
  clearAllMusic();
  _setDisconnectGraceMsForTests(15000);
  _setMusicIdleForTests({});
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
  const emitted = []; // direct socket.emit calls (errors, room-state, hydrate)
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
// The victim alone — the idle-timer shape.
const seedLoneDj = () => {
  presence.addOccupant('room1', 'sock-victim', { id: VICTIM_ID, name: 'User-aaaa' });
};

const claim = (sock, payload = { roomId: 'room1' }) => sock.handlers['music-dj-claim'](payload);
const release = (sock, payload = { roomId: 'room1' }) => sock.handlers['music-dj-release'](payload);
const queueAdd = (sock, track) => sock.handlers['music-queue-add']({ roomId: 'room1', track });
const queueRemove = (sock, trackId) => sock.handlers['music-queue-remove']({ roomId: 'room1', trackId });
const skip = (sock) => sock.handlers['music-skip']({ roomId: 'room1' });
const play = (sock) => sock.handlers['music-play']({ roomId: 'room1' });
const pause = (sock) => sock.handlers['music-pause']({ roomId: 'room1' });
const stop = (sock) => sock.handlers['music-stop']({ roomId: 'room1' });

const roomBroadcasts = (io, event) =>
  io.delivered.filter((d) => d.to === 'room1' && d.event === event);
const lastState = (io) => roomBroadcasts(io, 'music-state').at(-1)?.payload;
const errorsTo = (sock) => sock.emitted.filter((e) => e.event === 'music-error');

const RADIO = { title: 'Lo-fi Radio', url: 'https://example.com/stream.mp3', source: 'radio', duration: null };
const YT_RESOLVED = {
  title: 'Test Song',
  url: 'https://rr1---sn-abc123.googlevideo.com/videoplayback?expire=1&sig=abc',
  source: 'youtube',
  duration: 213
};

// --- claim + broadcast ------------------------------------------------------

test('first claim broadcasts music-state with the DJ', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  await claim(victim);
  const states = roomBroadcasts(io, 'music-state');
  assert.equal(states.length, 1);
  assert.deepEqual(states[0].payload, {
    dj: { userId: VICTIM_ID, name: 'User-aaaa' },
    queue: [], nowPlaying: null, playing: false
  });
  assert.equal(victim.emitted.length, 0); // no error to the claimant
});

test('second claimant gets music-error "Someone else is DJing" and no broadcast', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await claim(victim);
  await claim(attacker);
  assert.equal(roomBroadcasts(io, 'music-state').length, 1);
  assert.equal(errorsTo(attacker).length, 1);
  assert.equal(errorsTo(attacker)[0].payload.message, 'Someone else is DJing');
});

test('same user re-claiming is idempotent — no error, one broadcast each time', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  await claim(victim);
  await claim(victim);
  assert.equal(roomBroadcasts(io, 'music-state').length, 2);
  assert.equal(victim.emitted.length, 0);
});

test('holder releasing broadcasts the empty DJ slot; a non-holder releasing is a no-op', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await claim(victim);
  await release(attacker);
  assert.equal(roomBroadcasts(io, 'music-state').length, 1, 'non-holder release changes nothing');
  await release(victim);
  const states = roomBroadcasts(io, 'music-state');
  assert.equal(states.length, 2);
  assert.equal(states[1].payload.dj, null);
});

// --- queue ------------------------------------------------------------------

test('any member can queue a radio track; the server assigns the id', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await queueAdd(attacker, RADIO);
  const state = lastState(io);
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].title, 'Lo-fi Radio');
  assert.equal(state.queue[0].addedBy, ATTACKER_ID);
  assert.match(state.queue[0].id, /^[0-9a-f-]{36}$/, 'server-assigned UUID');
  assert.equal(state.playing, false, 'queueing never starts playback');
});

test('queueing a resolved YouTube track works; a raw youtube.com URL is refused', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await queueAdd(attacker, YT_RESOLVED);
  assert.equal(lastState(io).queue.length, 1);
  await queueAdd(attacker, { title: 'Raw', url: 'https://www.youtube.com/watch?v=x', source: 'youtube', duration: 5 });
  assert.equal(lastState(io).queue.length, 1, 'the bad track was not queued');
  assert.equal(errorsTo(attacker).length, 1);
  assert.match(errorsTo(attacker)[0].payload.message, /resolved stream URL/);
});

test('queueing an invalid track answers music-error and broadcasts nothing', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await queueAdd(attacker, { title: '', url: 'https://example.com/a.mp3', source: 'radio' });
  assert.equal(roomBroadcasts(io, 'music-state').length, 0);
  assert.equal(errorsTo(attacker).length, 1);
});

test('DJ or owner/mod can remove a track; a plain member cannot', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await claim(attacker); // attacker is the DJ
  await queueAdd(victim, RADIO);
  const trackId = lastState(io).queue[0].id;
  // The room owner (victim) can remove even though the attacker is DJ.
  await queueRemove(victim, trackId);
  assert.equal(lastState(io).queue.length, 0);
  // Re-queue, then a plain member (attacker is DJ here, so use a
  // third shape: attacker releases, victim claims, attacker removes).
  await queueAdd(victim, RADIO);
  const id2 = lastState(io).queue[0].id;
  await release(attacker);
  await claim(victim);
  await queueRemove(attacker, id2);
  assert.equal(errorsTo(attacker).length, 1);
  assert.match(errorsTo(attacker)[0].payload.message, /Only the DJ or a room owner\/moderator/);
  assert.equal(lastState(io).queue.length, 1, 'the track survives a refused remove');
});

// --- skip / play / pause / stop ----------------------------------------------

test('skip moves the next track to nowPlaying; only DJ or owner/mod may skip', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await claim(victim);
  await queueAdd(victim, RADIO);
  await queueAdd(victim, { ...RADIO, title: 'Second' });
  await skip(attacker);
  assert.equal(errorsTo(attacker).length, 1);
  assert.equal(lastState(io).nowPlaying, null, 'refused skip changed nothing');
  await skip(victim);
  const state = lastState(io);
  assert.equal(state.nowPlaying.title, 'Lo-fi Radio');
  assert.equal(state.playing, true);
  assert.deepEqual(state.queue.map((t) => t.title), ['Second']);
});

test('play/pause are DJ-only', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await claim(victim);
  await queueAdd(victim, RADIO);
  await skip(victim);
  await pause(attacker);
  assert.equal(errorsTo(attacker).length, 1);
  assert.equal(errorsTo(attacker)[0].payload.message, 'Only the DJ can control playback');
  assert.equal(lastState(io).playing, true);
  await pause(victim);
  assert.equal(lastState(io).playing, false);
  assert.equal(lastState(io).nowPlaying.title, 'Lo-fi Radio', 'pause keeps nowPlaying');
  await play(victim);
  assert.equal(lastState(io).playing, true);
});

test('play with a queued track and no nowPlaying starts the first track', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  const { io, victim } = connectPair();
  seedRoom();
  await claim(victim);
  await queueAdd(victim, RADIO);
  assert.equal(lastState(io).nowPlaying, null, 'queue-add alone starts nothing');
  assert.equal(lastState(io).playing, false);
  await play(victim);
  assert.equal(lastState(io).nowPlaying.title, 'Lo-fi Radio', 'play advances the first queued track');
  assert.equal(lastState(io).playing, true);
  assert.deepEqual(lastState(io).queue, [], 'the started track leaves the queue');
  // Pause then play resumes the same track instead of advancing.
  await pause(victim);
  await play(victim);
  assert.equal(lastState(io).nowPlaying.title, 'Lo-fi Radio');
  assert.equal(lastState(io).playing, true);
});

test('play with an empty queue and no nowPlaying leaves playback off', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  const { io, victim } = connectPair();
  seedRoom();
  await claim(victim);
  await play(victim);
  assert.equal(lastState(io).nowPlaying, null);
  assert.equal(lastState(io).playing, false, 'no track, no phantom playing state');
});

test('stop is owner/mod-only and clears queue + nowPlaying + DJ', async () => {
  stubRooms({ room1: privateRoomBothMembers });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await claim(attacker); // attacker DJs; victim owns the room
  await queueAdd(attacker, RADIO);
  await skip(attacker);
  await stop(attacker);
  assert.equal(errorsTo(attacker).length, 1);
  assert.match(errorsTo(attacker)[0].payload.message, /Only a room owner\/moderator/);
  await stop(victim);
  assert.deepEqual(lastState(io), { dj: null, queue: [], nowPlaying: null, playing: false });
  // The slot is free again after a stop.
  await claim(attacker);
  assert.equal(errorsTo(attacker).length, 1, 'no new error');
  assert.equal(lastState(io).dj.userId, ATTACKER_ID);
});

// --- auto-release on leave / disconnect ---------------------------------------

test('leave-room releases the DJ slot, stops playback, keeps the queue, and broadcasts', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await claim(victim);
  await queueAdd(victim, RADIO);
  await queueAdd(victim, { ...RADIO, title: 'Second' });
  await skip(victim);
  victim.handlers['leave-room']({ roomId: 'room1' });
  const state = lastState(io);
  assert.equal(state.dj, null);
  assert.equal(state.playing, false);
  assert.equal(state.nowPlaying.title, 'Lo-fi Radio', 'nowPlaying keeps for the next DJ');
  assert.deepEqual(state.queue.map((t) => t.title), ['Second']);
  // The slot is free again.
  await claim(attacker);
  assert.equal(errorsTo(attacker).length, 0);
});

test('disconnect releases the DJ slot after the grace, keeping the queue', async () => {
  _setDisconnectGraceMsForTests(50);
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await claim(victim);
  await queueAdd(victim, RADIO);
  await skip(victim);
  victim.handlers.disconnect();
  assert.equal(lastState(io).dj.userId, VICTIM_ID, 'no release inside the grace');
  await new Promise((r) => setTimeout(r, 100));
  const state = lastState(io);
  assert.equal(state.dj, null);
  assert.equal(state.playing, false);
  assert.equal(state.nowPlaying.title, 'Lo-fi Radio');
  await claim(attacker);
  assert.equal(errorsTo(attacker).length, 0);
});

// --- gating: presence + membership ---------------------------------------------

test('a socket that never joined cannot claim or queue (silent drop)', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  presence.removeOccupant('room1', 'sock-attacker');
  presence.addOccupant('room1', 'sock-third', { id: 'cccccccccccccccccccccccc', name: 'Third' });
  await claim(attacker);
  await queueAdd(attacker, RADIO);
  assert.equal(roomBroadcasts(io, 'music-state').length, 0);
  assert.equal(attacker.emitted.length, 0); // silent — a prober learns nothing
});

test('a non-member cannot DJ in a private room even when present', async () => {
  stubRooms({ room1: privateRoomVictimOnly });
  const { io, victim, attacker } = connectPair();
  seedRoom();
  await claim(attacker);
  assert.equal(roomBroadcasts(io, 'music-state').length, 0);
  assert.equal(attacker.emitted.length, 0);
  await claim(victim);
  assert.equal(roomBroadcasts(io, 'music-state').length, 1);
});

test('a music event naming a room the socket is not in is dropped', async () => {
  stubRooms({ room1: publicRoom, room2: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  await claim(victim, { roomId: 'room2' });
  assert.equal(roomBroadcasts(io, 'music-state').length, 0);
  assert.equal(victim.emitted.length, 0);
});

// --- join hydration ------------------------------------------------------------

test('room-state join hydrates the music panel for a late joiner', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  await victim.handlers['join-room']({ roomId: 'room1' });
  await claim(victim);
  await queueAdd(victim, RADIO);
  await skip(victim);
  await attacker.handlers['join-room']({ roomId: 'room1' });
  const states = attacker.emitted.filter((e) => e.event === 'music-state');
  assert.equal(states.length, 1);
  assert.equal(states[0].payload.dj.userId, VICTIM_ID);
  assert.equal(states[0].payload.dj.name, 'User-aaaa');
  assert.equal(states[0].payload.nowPlaying.title, 'Lo-fi Radio');
  assert.equal(states[0].payload.playing, true);
});

// --- rate limiting ---------------------------------------------------------------

test('music-dj-claim is rate-limited (5 burst, then dropped)', async () => {
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom();
  for (let i = 0; i < 6; i++) await claim(victim);
  assert.equal(roomBroadcasts(io, 'music-state').length, 5, 'the 6th rapid claim is dropped');
});

// --- idle auto-disconnect ----------------------------------------------------------

test('lone DJ with active music gets warning then disconnect + dj-null state, queue kept', async () => {
  _setMusicIdleForTests({ timeoutMs: 120, warningMs: 60 });
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedLoneDj();
  await claim(victim);
  await queueAdd(victim, RADIO);
  await skip(victim); // nowPlaying set, playing true, DJ alone
  await new Promise((r) => setTimeout(r, 90));
  const warnings = roomBroadcasts(io, 'music-idle-warning');
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].payload, { secondsRemaining: 60 });
  await new Promise((r) => setTimeout(r, 90));
  const disconnects = roomBroadcasts(io, 'music-idle-disconnect');
  assert.equal(disconnects.length, 1);
  assert.equal(disconnects[0].payload.message, 'Music Bot left — room was idle for 5 minutes');
  const state = lastState(io);
  assert.equal(state.dj, null);
  assert.equal(state.playing, false);
  assert.equal(state.nowPlaying.title, 'Lo-fi Radio', 'the queue persists for the next DJ');
});

test('a listener joining before the fire cancels the idle disconnect', async () => {
  _setMusicIdleForTests({ timeoutMs: 120, warningMs: 60 });
  stubRooms({ room1: publicRoom });
  const { io, victim, attacker } = connectPair();
  seedLoneDj();
  await claim(victim);
  await queueAdd(victim, RADIO);
  await skip(victim);
  await attacker.handlers['join-room']({ roomId: 'room1' });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(roomBroadcasts(io, 'music-idle-warning').length, 0);
  assert.equal(roomBroadcasts(io, 'music-idle-disconnect').length, 0);
  assert.equal(lastState(io).dj.userId, VICTIM_ID, 'the DJ keeps the slot');
});

test('no idle timer when the DJ is not alone, or when music is inactive', async () => {
  _setMusicIdleForTests({ timeoutMs: 120, warningMs: 60 });
  stubRooms({ room1: publicRoom });
  const { io, victim } = connectPair();
  seedRoom(); // two occupants: DJ is not alone
  await claim(victim);
  await queueAdd(victim, RADIO);
  await skip(victim);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(roomBroadcasts(io, 'music-idle-warning').length, 0);
  assert.equal(roomBroadcasts(io, 'music-idle-disconnect').length, 0);
});
