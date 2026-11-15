// Music bot — per-room DJ + queue state (v0.10.0).
//
// Pure + testable: the store is a Map injected by the caller
// (roomId -> state), so unit tests get a fresh one and the server
// (lib/socket.js) passes its module-level map. No socket.io, no DB,
// no timers — the socket layer owns the broadcast, this module only
// decides what the state is. The idle timer lives in
// lib/musicIdle.js; it reads this state through isMusicActive().
//
// State per room:
//   { dj: { userId, socketId } | null,
//     queue: [track], nowPlaying: track | null, playing: boolean }
// Track:
//   { id, title, url, source: 'youtube' | 'radio',
//     duration: number | null, addedBy: userId }
//
// One DJ at a time, per room — same semantics as lib/screenShare.js:
// a second claimant gets MUSIC_DJ_BUSY_MESSAGE, a re-claim by the
// current DJ is idempotent. The DJ slot dies with the holder
// (clearDjForSocket on leave / disconnect / idle timeout): the DJ
// goes, playback stops, but the queue + nowPlaying KEEP — the next
// DJ resumes where the last one left off. music-stop (owner/mod)
// is the hard stop: it clears the queue and nowPlaying too.
//
// YouTube tracks may only carry resolved googlevideo URLs: the
// client resolves a YouTube link through POST /api/music/youtube
// first, and only the resolved stream URL may be queued — a raw
// youtube.com watch URL in the queue would make every listener's
// browser fetch YouTube directly, which is exactly what the
// server-side resolution exists to avoid.

const MAX_QUEUE_LENGTH = 50;
const MUSIC_DJ_BUSY_MESSAGE = 'Someone else is DJing';
const QUEUE_FULL_MESSAGE = 'The queue is full (50 tracks)';

const createMusicStore = () => new Map();

// Fresh empty state for a room. Returned by reference from the store
// (the socket layer mutates through the functions below, never by
// hand) — callers that only read should treat it as read-only.
const freshMusicState = () => ({ dj: null, queue: [], nowPlaying: null, playing: false });

const getOrCreateMusicState = (store, roomId) => {
  const id = String(roomId);
  let state = store.get(id);
  if (!state) {
    state = freshMusicState();
    store.set(id, state);
  }
  return state;
};

// Validate a track the client wants queued. Returns
// { ok: true, track } with a normalized copy (unknown fields dropped)
// or { ok: false, error } with a client-facing message.
//   - title: 1–200 chars
//   - url: http(s)
//   - source: 'youtube' | 'radio'
//   - youtube: the host MUST end with '.googlevideo.com' — only
//     server-resolved stream URLs may be queued (see header)
//   - duration: null, or a finite number >= 0
// The id / addedBy are assigned by the caller (the socket layer
// assigns a randomUUID + the sender) and carried through untouched.
const validateTrack = (track) => {
  if (!track || typeof track !== 'object') {
    return { ok: false, error: 'A track is required' };
  }
  const title = typeof track.title === 'string' ? track.title.trim() : '';
  if (title.length < 1 || title.length > 200) {
    return { ok: false, error: 'Track title must be 1–200 characters' };
  }
  let url;
  try {
    url = new URL(String(track.url || ''));
  } catch {
    return { ok: false, error: 'Track URL must be a valid http(s) URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Track URL must be a valid http(s) URL' };
  }
  if (track.source !== 'youtube' && track.source !== 'radio') {
    return { ok: false, error: "Track source must be 'youtube' or 'radio'" };
  }
  if (track.source === 'youtube' && !url.hostname.endsWith('.googlevideo.com')) {
    return { ok: false, error: 'YouTube tracks must use a resolved stream URL' };
  }
  const duration = track.duration == null ? null : track.duration;
  if (duration !== null && (!Number.isFinite(duration) || duration < 0)) {
    return { ok: false, error: 'Track duration must be a number of seconds, or null' };
  }
  return {
    ok: true,
    track: {
      id: track.id,
      title,
      url: url.toString(),
      source: track.source,
      duration,
      addedBy: track.addedBy
    }
  };
};

// Append a track to the room's queue (cap 50). Returns
// { ok: true, track } or { ok: false, error } (full / invalid).
// Adding never starts playback — the DJ controls play/pause.
const addTrack = (store, roomId, track) => {
  const state = getOrCreateMusicState(store, roomId);
  if (state.queue.length >= MAX_QUEUE_LENGTH) {
    return { ok: false, error: QUEUE_FULL_MESSAGE };
  }
  const validated = validateTrack(track);
  if (!validated.ok) return validated;
  state.queue.push(validated.track);
  return { ok: true, track: validated.track };
};

// Remove one track from the queue by id. Returns true when a track
// was removed, false when the id was not queued. Role enforcement
// (DJ or owner/mod) is the caller's job — this only removes.
// nowPlaying is never removed this way; skip/stop move it.
const removeTrack = (store, roomId, trackId) => {
  const state = getOrCreateMusicState(store, roomId);
  const idx = state.queue.findIndex((t) => String(t.id) === String(trackId));
  if (idx < 0) return false;
  state.queue.splice(idx, 1);
  return true;
};

// Skip: nowPlaying becomes the next queued track (or null when the
// queue is empty). playing stays true only while a track exists —
// skipping past the last track stops playback, it does not leave the
// room "playing" nothing. Returns the new state.
const advance = (store, roomId) => {
  const state = getOrCreateMusicState(store, roomId);
  state.nowPlaying = state.queue.shift() || null;
  state.playing = state.nowPlaying !== null;
  return state;
};

// DJ-only play/pause. Returns the new state.
const setPlaying = (store, roomId, playing) => {
  const state = getOrCreateMusicState(store, roomId);
  state.playing = Boolean(playing);
  return state;
};

// Claim the room's DJ slot for (userId, socketId). Returns
// { ok: true } on success (including a re-claim by the current DJ —
// the slot just follows their newest socket), or
// { ok: false, error, djUserId } when someone else holds it.
const claimDj = (store, roomId, userId, socketId) => {
  const state = getOrCreateMusicState(store, roomId);
  if (state.dj && String(state.dj.userId) !== String(userId)) {
    return { ok: false, error: MUSIC_DJ_BUSY_MESSAGE, djUserId: state.dj.userId };
  }
  state.dj = { userId: String(userId), socketId: String(socketId) };
  return { ok: true };
};

// Release the slot, but only when it belongs to this user — a
// non-DJ stopping (or a stale stop after a takeover) must never
// clear someone else's slot. Releasing stops playback (nobody is
// playing anymore) but keeps the queue + nowPlaying for the next DJ.
// Returns true when a slot was released.
const releaseDj = (store, roomId, userId) => {
  const state = getOrCreateMusicState(store, roomId);
  if (!state.dj || String(state.dj.userId) !== String(userId)) return false;
  state.dj = null;
  state.playing = false;
  return true;
};

// Who holds the DJ slot in this room, or null.
const djForRoom = (store, roomId) => {
  const state = store.get(String(roomId));
  return state && state.dj
    ? { userId: state.dj.userId, socketId: state.dj.socketId }
    : null;
};

// The DJ is leaving (leave-room / disconnect / idle timeout): drop
// whatever slot their socket holds, in whatever room it was.
// Playback stops, but the queue + nowPlaying KEEP so the next DJ
// resumes. Returns { roomId, userId } when a slot was cleared, else
// null — the caller broadcasts the new music-state only when
// non-null.
const clearDjForSocket = (store, socketId) => {
  for (const [roomId, state] of store) {
    if (state.dj && String(state.dj.socketId) === String(socketId)) {
      const userId = state.dj.userId;
      state.dj = null;
      state.playing = false;
      return { roomId, userId };
    }
  }
  return null;
};

// Hard stop (owner/mod music-stop): playback off, DJ released, queue
// + nowPlaying cleared. The room is silent and empty of music.
const stopMusic = (store, roomId) => {
  const state = getOrCreateMusicState(store, roomId);
  state.dj = null;
  state.queue = [];
  state.nowPlaying = null;
  state.playing = false;
  return state;
};

// Drop a room's music state entirely (room deleted). Entries also
// die on restart — the store is in-memory by design.
const clearRoom = (store, roomId) => store.delete(String(roomId));

// Is there anything to listen to (or queued to listen to) in this
// room? The idle timer (lib/musicIdle.js) reads this: a lone DJ
// with an active room gets the 5-minute timer, a lone DJ with an
// empty, stopped room does not.
const isMusicActive = (state) =>
  !!state && (state.playing === true || state.queue.length > 0 || state.nowPlaying !== null);

module.exports = {
  MAX_QUEUE_LENGTH,
  MUSIC_DJ_BUSY_MESSAGE,
  QUEUE_FULL_MESSAGE,
  createMusicStore,
  freshMusicState,
  getOrCreateMusicState,
  validateTrack,
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
};
