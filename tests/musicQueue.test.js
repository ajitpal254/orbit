// Tests for the pure music state module (v0.10.0): queue + DJ slot
// logic in lib/musicQueue.js. No socket.io, no DB, no timers — a
// fresh store per test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_QUEUE_LENGTH,
  MUSIC_DJ_BUSY_MESSAGE,
  createMusicStore,
  getOrCreateMusicState,
  addTrack,
  removeTrack,
  advance,
  setPlaying,
  claimDj,
  releaseDj,
  djForRoom,
  clearDjForSocket,
  stopMusic,
  clearRoom,
  isMusicActive
} = require('../lib/musicQueue');

const ROOM = 'room1';
const DJ = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const ytTrack = (over = {}) => ({
  id: 'track-1',
  title: 'Test Song',
  url: 'https://rr1---sn-abc123.googlevideo.com/videoplayback?expire=1&sig=abc',
  source: 'youtube',
  duration: 213,
  addedBy: DJ,
  ...over
});
const radioTrack = (over = {}) => ({
  id: 'track-2',
  title: 'Lo-fi Radio',
  url: 'https://example.com/stream.mp3',
  source: 'radio',
  duration: null,
  addedBy: DJ,
  ...over
});

// --- queue + validation -------------------------------------------------------

test('fresh state is empty, silent, and inactive', () => {
  const store = createMusicStore();
  const state = getOrCreateMusicState(store, ROOM);
  assert.deepEqual(state, { dj: null, queue: [], nowPlaying: null, playing: false });
  assert.equal(isMusicActive(state), false);
});

test('addTrack appends a valid YouTube track and normalizes it', () => {
  const store = createMusicStore();
  const res = addTrack(store, ROOM, ytTrack({ title: '  Padded Title  ', extra: 'dropped' }));
  assert.equal(res.ok, true);
  assert.equal(res.track.title, 'Padded Title');
  assert.equal(res.track.extra, undefined);
  assert.equal(getOrCreateMusicState(store, ROOM).queue.length, 1);
});

test('addTrack accepts a radio track from any http(s) host', () => {
  const store = createMusicStore();
  assert.equal(addTrack(store, ROOM, radioTrack()).ok, true);
});

test('addTrack rejects a YouTube track whose host is not googlevideo', () => {
  const store = createMusicStore();
  const raw = addTrack(store, ROOM, ytTrack({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
  assert.equal(raw.ok, false);
  assert.match(raw.error, /resolved stream URL/);
  assert.equal(getOrCreateMusicState(store, ROOM).queue.length, 0);
});

test('addTrack rejects a youtube.com host even with a googlevideo-looking path', () => {
  const store = createMusicStore();
  const res = addTrack(store, ROOM, ytTrack({ url: 'https://music.youtube.com/watch?v=x' }));
  assert.equal(res.ok, false);
});

test('addTrack accepts a googlevideo subdomain host', () => {
  const store = createMusicStore();
  const res = addTrack(store, ROOM, ytTrack({ url: 'https://rr2---sn-p5qlsnd6.googlevideo.com/videoplayback?x=1' }));
  assert.equal(res.ok, true);
});

test('addTrack rejects bad titles, urls, sources and durations', () => {
  const store = createMusicStore();
  assert.equal(addTrack(store, ROOM, ytTrack({ title: '' })).ok, false);
  assert.equal(addTrack(store, ROOM, ytTrack({ title: 'x'.repeat(201) })).ok, false);
  assert.equal(addTrack(store, ROOM, ytTrack({ url: 'ftp://example.com/a.mp3' })).ok, false);
  assert.equal(addTrack(store, ROOM, ytTrack({ url: 'not a url' })).ok, false);
  assert.equal(addTrack(store, ROOM, ytTrack({ source: 'spotify' })).ok, false);
  assert.equal(addTrack(store, ROOM, ytTrack({ duration: -5 })).ok, false);
  assert.equal(addTrack(store, ROOM, ytTrack({ duration: 'long' })).ok, false);
  assert.equal(addTrack(store, ROOM, null).ok, false);
  assert.equal(getOrCreateMusicState(store, ROOM).queue.length, 0);
});

test('addTrack caps the queue at 50 and reports it', () => {
  const store = createMusicStore();
  for (let i = 0; i < MAX_QUEUE_LENGTH; i++) {
    const res = addTrack(store, ROOM, radioTrack({ id: `t${i}` }));
    assert.equal(res.ok, true, `track ${i} should queue`);
  }
  const full = addTrack(store, ROOM, radioTrack({ id: 't51' }));
  assert.equal(full.ok, false);
  assert.match(full.error, /full/);
  assert.equal(getOrCreateMusicState(store, ROOM).queue.length, MAX_QUEUE_LENGTH);
});

test('removeTrack removes by id and reports misses', () => {
  const store = createMusicStore();
  addTrack(store, ROOM, radioTrack({ id: 'a' }));
  addTrack(store, ROOM, radioTrack({ id: 'b' }));
  assert.equal(removeTrack(store, ROOM, 'missing'), false);
  assert.equal(removeTrack(store, ROOM, 'a'), true);
  assert.deepEqual(getOrCreateMusicState(store, ROOM).queue.map((t) => t.id), ['b']);
});

// --- advance / playing ---------------------------------------------------------

test('advance moves the next queued track to nowPlaying and keeps playing', () => {
  const store = createMusicStore();
  addTrack(store, ROOM, radioTrack({ id: 'a' }));
  addTrack(store, ROOM, radioTrack({ id: 'b' }));
  const state = advance(store, ROOM);
  assert.equal(state.nowPlaying.id, 'a');
  assert.equal(state.playing, true);
  assert.deepEqual(state.queue.map((t) => t.id), ['b']);
  assert.equal(isMusicActive(state), true);
});

test('advance past the last track stops playback (nowPlaying null, playing false)', () => {
  const store = createMusicStore();
  addTrack(store, ROOM, radioTrack({ id: 'a' }));
  advance(store, ROOM);
  const state = advance(store, ROOM);
  assert.equal(state.nowPlaying, null);
  assert.equal(state.playing, false);
  assert.equal(isMusicActive(state), false);
});

test('advance on an empty room is a no-op that stays silent', () => {
  const store = createMusicStore();
  const state = advance(store, ROOM);
  assert.equal(state.nowPlaying, null);
  assert.equal(state.playing, false);
});

test('setPlaying toggles playback without touching the queue', () => {
  const store = createMusicStore();
  addTrack(store, ROOM, radioTrack({ id: 'a' }));
  advance(store, ROOM);
  assert.equal(setPlaying(store, ROOM, false).playing, false);
  assert.equal(getOrCreateMusicState(store, ROOM).nowPlaying.id, 'a');
  assert.equal(setPlaying(store, ROOM, true).playing, true);
});

// --- DJ slot -------------------------------------------------------------------

test('first claim wins; a second user gets "Someone else is DJing"', () => {
  const store = createMusicStore();
  assert.deepEqual(claimDj(store, ROOM, DJ, 'sock-dj'), { ok: true });
  const res = claimDj(store, ROOM, OTHER, 'sock-other');
  assert.equal(res.ok, false);
  assert.equal(res.error, MUSIC_DJ_BUSY_MESSAGE);
  assert.equal(res.djUserId, DJ);
  assert.deepEqual(djForRoom(store, ROOM), { userId: DJ, socketId: 'sock-dj' });
});

test('same user re-claiming is idempotent and follows the newest socket', () => {
  const store = createMusicStore();
  claimDj(store, ROOM, DJ, 'sock-1');
  assert.deepEqual(claimDj(store, ROOM, DJ, 'sock-2'), { ok: true });
  assert.deepEqual(djForRoom(store, ROOM), { userId: DJ, socketId: 'sock-2' });
});

test('release by the holder frees the slot and stops playback; a non-holder cannot release', () => {
  const store = createMusicStore();
  claimDj(store, ROOM, DJ, 'sock-dj');
  addTrack(store, ROOM, radioTrack());
  advance(store, ROOM);
  assert.equal(releaseDj(store, ROOM, OTHER), false);
  assert.equal(djForRoom(store, ROOM).userId, DJ);
  assert.equal(releaseDj(store, ROOM, DJ), true);
  assert.equal(djForRoom(store, ROOM), null);
  const state = getOrCreateMusicState(store, ROOM);
  assert.equal(state.playing, false);
  // Queue + nowPlaying keep for the next DJ.
  assert.equal(state.queue.length, 0);
  assert.equal(state.nowPlaying.id, 'track-2');
});

test('release keeps a queued (unplayed) queue for the next DJ', () => {
  const store = createMusicStore();
  claimDj(store, ROOM, DJ, 'sock-dj');
  addTrack(store, ROOM, radioTrack({ id: 'a' }));
  addTrack(store, ROOM, radioTrack({ id: 'b' }));
  releaseDj(store, ROOM, DJ);
  const state = getOrCreateMusicState(store, ROOM);
  assert.deepEqual(state.queue.map((t) => t.id), ['a', 'b']);
  assert.equal(isMusicActive(state), true, 'a queued room is still active');
});

test('clearDjForSocket releases the holder, stops playback, keeps queue + nowPlaying', () => {
  const store = createMusicStore();
  claimDj(store, ROOM, DJ, 'sock-dj');
  addTrack(store, ROOM, radioTrack({ id: 'a' }));
  addTrack(store, ROOM, radioTrack({ id: 'b' }));
  advance(store, ROOM);
  // A stranger's socket clears nothing.
  assert.equal(clearDjForSocket(store, 'sock-other'), null);
  assert.equal(djForRoom(store, ROOM).userId, DJ);
  const cleared = clearDjForSocket(store, 'sock-dj');
  assert.deepEqual(cleared, { roomId: ROOM, userId: DJ });
  const state = getOrCreateMusicState(store, ROOM);
  assert.equal(state.dj, null);
  assert.equal(state.playing, false);
  assert.equal(state.nowPlaying.id, 'a');
  assert.deepEqual(state.queue.map((t) => t.id), ['b']);
  assert.equal(isMusicActive(state), true, 'queue + nowPlaying keep the room active');
});

test('stopMusic clears DJ, queue, nowPlaying and playback', () => {
  const store = createMusicStore();
  claimDj(store, ROOM, DJ, 'sock-dj');
  addTrack(store, ROOM, radioTrack({ id: 'a' }));
  advance(store, ROOM);
  const state = stopMusic(store, ROOM);
  assert.deepEqual(state, { dj: null, queue: [], nowPlaying: null, playing: false });
  assert.equal(isMusicActive(state), false);
});

test('clearRoom drops the room state entirely', () => {
  const store = createMusicStore();
  claimDj(store, ROOM, DJ, 'sock-dj');
  addTrack(store, ROOM, radioTrack());
  clearRoom(store, ROOM);
  assert.equal(store.has(ROOM), false);
  assert.equal(djForRoom(store, ROOM), null);
  // A fresh state is born on next access.
  assert.deepEqual(getOrCreateMusicState(store, ROOM), { dj: null, queue: [], nowPlaying: null, playing: false });
});

test('rooms are independent', () => {
  const store = createMusicStore();
  claimDj(store, 'room1', DJ, 'sock-dj');
  claimDj(store, 'room2', OTHER, 'sock-other');
  assert.equal(djForRoom(store, 'room1').userId, DJ);
  assert.equal(djForRoom(store, 'room2').userId, OTHER);
  addTrack(store, 'room1', radioTrack({ id: 'a' }));
  assert.equal(getOrCreateMusicState(store, 'room2').queue.length, 0);
});
