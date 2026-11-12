// Together mode (playbook item 6): a shared focus timer per room.
//
// In-memory only, like presence — a restart clears sessions, which is
// correct: a focus session is live state, not data. One session per
// room; starting while one runs is a conflict, never a second session.
// The session is { roomId, startedAt, durationSec } — clients derive
// the same remaining time from startedAt, so every client (including
// late joiners, who get the session in room-state) counts down in sync.
//
// The store is a Map, injected (createFocusStore) so tests get a fresh
// one; the module singleton `focusSessions` is what the server uses.
// Expiry is enforced two ways: the socket layer arms a timer that
// broadcasts 'focus-ended', and getSession lazily drops an expired
// session at read time (the same read-time backstop fading chat uses),
// so a missed broadcast can never resurrect a dead session.
//
// A session survives members joining/leaving mid-session, and it
// survives the room emptying (a campfire rejoin within its 60s fade
// window finds the timer still running). It dies with the room: the
// DELETE route and the campfire cleanup's onClosed both clear it.

const { getRole } = require('./roles');

const FOCUS_MIN_SECONDS = 60; // 1 minute
const FOCUS_MAX_SECONDS = 2 * 60 * 60; // 2 hours
const FOCUS_PRESET_MINUTES = [15, 25, 45, 60];

const createFocusStore = () => new Map();

// The server's live sessions: roomId -> { roomId, startedAt, durationSec }.
const focusSessions = createFocusStore();

const isValidDurationSec = (n) =>
  Number.isInteger(n) && n >= FOCUS_MIN_SECONDS && n <= FOCUS_MAX_SECONDS;

// Expired at or after endsAt: the boundary belongs to "ended", so a
// session whose duration has exactly elapsed is gone, not running.
const isExpired = (session, now = Date.now()) =>
  !session || now >= session.startedAt + session.durationSec * 1000;

// Remaining milliseconds, clamped at 0 — never negative.
const remainingMs = (session, now = Date.now()) => {
  if (!session) return 0;
  return Math.max(0, session.startedAt + session.durationSec * 1000 - now);
};

// Elapsed fraction 0..1, clamped — drives the client ring.
const progress = (session, now = Date.now()) => {
  if (!session) return 0;
  const total = session.durationSec * 1000;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - session.startedAt) / total));
};

// Start a session. A live one already running is a conflict
// ({ ok: false, error: 'already-running' }) — the caller answers 409
// semantics to the client (an 'error' socket event), never a second
// session. An expired one is replaced: its time is up, the room is
// free to focus again.
const startSession = (store, roomId, durationSec, now = Date.now()) => {
  const id = String(roomId);
  if (!isValidDurationSec(durationSec)) {
    return { ok: false, error: 'Duration must be 1–120 minutes' };
  }
  const existing = store.get(id);
  if (existing && !isExpired(existing, now)) {
    return { ok: false, error: 'already-running', session: existing };
  }
  const session = { roomId: id, startedAt: now, durationSec };
  store.set(id, session);
  return { ok: true, session };
};

// Stop a session. Returns the stopped session, or null when nothing
// was running — stopping an idle room is a no-op, not an error.
const stopSession = (store, roomId) => {
  const id = String(roomId);
  const session = store.get(id) || null;
  if (session) store.delete(id);
  return session;
};

// The live session for a room, or null. Lazily drops an expired one,
// so a late joiner never sees a dead session.
const getSession = (store, roomId, now = Date.now()) => {
  const id = String(roomId);
  const session = store.get(id) || null;
  if (!session) return null;
  if (isExpired(session, now)) {
    store.delete(id);
    return null;
  }
  return session;
};

const clearSession = (store, roomId) => store.delete(String(roomId));

const clearAllSessions = (store) => store.clear();

// Who may start/stop a focus session: the room owner or a moderator.
// Public rooms have no member list — getRole still resolves the
// creator to 'owner', so the creator of a public focus room controls
// its timer. Plain members and non-members get false.
const canControlFocus = (room, userId) => {
  if (!room || userId == null) return false;
  const role = getRole(room, userId);
  return role === 'owner' || role === 'moderator';
};

// Public JSON shape for a session (what the socket broadcasts and
// room-state carries): everything the client needs to derive the same
// remaining time — startedAt + durationSec, never a server-computed
// "remaining" that would drift between clients.
const sessionJson = (session) =>
  session
    ? {
        roomId: session.roomId,
        startedAt: session.startedAt,
        durationSec: session.durationSec,
        endsAt: session.startedAt + session.durationSec * 1000
      }
    : null;

module.exports = {
  FOCUS_MIN_SECONDS,
  FOCUS_MAX_SECONDS,
  FOCUS_PRESET_MINUTES,
  createFocusStore,
  focusSessions,
  isValidDurationSec,
  isExpired,
  remainingMs,
  progress,
  startSession,
  stopSession,
  getSession,
  clearSession,
  clearAllSessions,
  canControlFocus,
  sessionJson
};
