// Tests for Together mode's server-side focus sessions
// (lib/focusSessions.js). Pure in-memory logic — no MongoDB needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FOCUS_MIN_SECONDS,
  FOCUS_MAX_SECONDS,
  FOCUS_PRESET_MINUTES,
  createFocusStore,
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
} = require('../lib/focusSessions');

const ROOM = 'room-1';
const T0 = 1_000_000_000_000; // fixed "now" so the math is exact
const D25 = 25 * 60; // 25 minutes in seconds

// Fake rooms. Ids are 24-hex strings so the role helpers resolve
// them (see lib/roles.js entryUserId).
const OWNER = 'a'.repeat(24);
const MOD = 'b'.repeat(24);
const MEMBER = 'c'.repeat(24);
const STRANGER = 'd'.repeat(24);

const publicRoom = {
  createdBy: OWNER,
  members: []
};
const privateRoom = {
  createdBy: OWNER,
  isPrivate: true,
  members: [
    { user: OWNER, role: 'owner' },
    { user: MOD, role: 'moderator' },
    { user: MEMBER, role: 'member' }
  ]
};

test('duration bounds: 60s–2h, integers only', () => {
  assert.equal(FOCUS_MIN_SECONDS, 60);
  assert.equal(FOCUS_MAX_SECONDS, 7200);
  assert.equal(isValidDurationSec(60), true);
  assert.equal(isValidDurationSec(7200), true);
  assert.equal(isValidDurationSec(1500), true);
  assert.equal(isValidDurationSec(0), false);
  assert.equal(isValidDurationSec(59), false);
  assert.equal(isValidDurationSec(7201), false);
  assert.equal(isValidDurationSec(-60), false);
  assert.equal(isValidDurationSec(90.5), false);
  assert.equal(isValidDurationSec('1500'), false);
  assert.equal(isValidDurationSec(NaN), false);
  assert.equal(isValidDurationSec(undefined), false);
  assert.deepEqual(FOCUS_PRESET_MINUTES, [15, 25, 45, 60]);
});

test('start returns the session and getSession finds it', () => {
  const store = createFocusStore();
  const res = startSession(store, ROOM, D25, T0);
  assert.equal(res.ok, true);
  assert.deepEqual(res.session, { roomId: ROOM, startedAt: T0, durationSec: D25 });
  assert.deepEqual(getSession(store, ROOM, T0), res.session);
});

test('start rejects an invalid duration without storing anything', () => {
  const store = createFocusStore();
  assert.equal(startSession(store, ROOM, 30, T0).ok, false);
  assert.equal(startSession(store, ROOM, 7201, T0).ok, false);
  assert.equal(getSession(store, ROOM, T0), null);
});

test('a second start while one runs is a conflict, not a second session', () => {
  const store = createFocusStore();
  const first = startSession(store, ROOM, D25, T0);
  assert.equal(first.ok, true);
  const second = startSession(store, ROOM, D25, T0 + 60_000);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'already-running');
  // The original session is untouched — same startedAt, same duration.
  assert.deepEqual(getSession(store, ROOM, T0 + 60_000), first.session);
  assert.equal(second.session.startedAt, T0);
});

test('starting after expiry replaces the dead session', () => {
  const store = createFocusStore();
  startSession(store, ROOM, D25, T0);
  const res = startSession(store, ROOM, D25, T0 + D25 * 1000);
  assert.equal(res.ok, true);
  assert.equal(res.session.startedAt, T0 + D25 * 1000);
});

test('remainingMs counts down from the server startedAt', () => {
  const store = createFocusStore();
  const { session } = startSession(store, ROOM, D25, T0);
  assert.equal(remainingMs(session, T0), D25 * 1000);
  assert.equal(remainingMs(session, T0 + 60_000), (D25 - 60) * 1000);
  // A late joiner 10 minutes in sees the same remaining time as
  // everyone else: 15 minutes left of a 25-minute session.
  assert.equal(remainingMs(getSession(store, ROOM, T0 + 600_000), T0 + 600_000), 15 * 60 * 1000);
  assert.equal(remainingMs(session, T0 + D25 * 1000), 0);
  assert.equal(remainingMs(null, T0), 0);
});

test('expiry boundary: alive 1ms before endsAt, gone exactly at endsAt', () => {
  const store = createFocusStore();
  const { session } = startSession(store, ROOM, D25, T0);
  const endsAt = T0 + D25 * 1000;
  assert.equal(isExpired(session, endsAt - 1), false);
  assert.equal(isExpired(session, endsAt), true);
  assert.equal(isExpired(session, endsAt + 1), true);
  assert.equal(isExpired(null, T0), true);
  // getSession lazily drops the expired session — a late joiner never
  // sees a dead one.
  assert.equal(getSession(store, ROOM, endsAt - 1)?.startedAt, T0);
  assert.equal(getSession(store, ROOM, endsAt), null);
  assert.equal(store.has(ROOM), false);
});

test('progress runs 0 → 0.5 → 1 and clamps past the end', () => {
  const store = createFocusStore();
  const { session } = startSession(store, ROOM, D25, T0);
  assert.equal(progress(session, T0), 0);
  assert.equal(progress(session, T0 + (D25 * 1000) / 2), 0.5);
  assert.equal(progress(session, T0 + D25 * 1000), 1);
  assert.equal(progress(session, T0 + D25 * 1000 + 60_000), 1);
  assert.equal(progress(null, T0), 0);
});

test('stop returns the session once, then null — stopping idle is a no-op', () => {
  const store = createFocusStore();
  assert.equal(stopSession(store, ROOM), null);
  const { session } = startSession(store, ROOM, D25, T0);
  assert.deepEqual(stopSession(store, ROOM), session);
  assert.equal(stopSession(store, ROOM), null);
  assert.equal(getSession(store, ROOM, T0), null);
});

test('sessions are per-room: stopping one leaves the other running', () => {
  const store = createFocusStore();
  startSession(store, 'room-a', D25, T0);
  startSession(store, 'room-b', D25, T0);
  stopSession(store, 'room-a');
  assert.equal(getSession(store, 'room-a', T0), null);
  assert.notEqual(getSession(store, 'room-b', T0), null);
});

test('clearSession and clearAllSessions drop sessions (room deleted / faded)', () => {
  const store = createFocusStore();
  startSession(store, 'room-a', D25, T0);
  startSession(store, 'room-b', D25, T0);
  clearSession(store, 'room-a');
  assert.equal(getSession(store, 'room-a', T0), null);
  assert.notEqual(getSession(store, 'room-b', T0), null);
  clearAllSessions(store);
  assert.equal(getSession(store, 'room-b', T0), null);
});

test('canControlFocus: owner and moderator yes, member and stranger no', () => {
  assert.equal(canControlFocus(privateRoom, OWNER), true);
  assert.equal(canControlFocus(privateRoom, MOD), true);
  assert.equal(canControlFocus(privateRoom, MEMBER), false);
  assert.equal(canControlFocus(privateRoom, STRANGER), false);
  // A public room has no member list — its creator is still the owner.
  assert.equal(canControlFocus(publicRoom, OWNER), true);
  assert.equal(canControlFocus(publicRoom, STRANGER), false);
  assert.equal(canControlFocus(null, OWNER), false);
  assert.equal(canControlFocus(privateRoom, null), false);
  assert.equal(canControlFocus(privateRoom, undefined), false);
});

test('sessionJson carries startedAt + durationSec + endsAt, or null', () => {
  const store = createFocusStore();
  const { session } = startSession(store, ROOM, D25, T0);
  assert.deepEqual(sessionJson(session), {
    roomId: ROOM,
    startedAt: T0,
    durationSec: D25,
    endsAt: T0 + D25 * 1000
  });
  assert.equal(sessionJson(null), null);
});
