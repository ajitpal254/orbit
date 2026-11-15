// Tests for the music idle auto-disconnect timers (v0.10.0):
// lib/musicIdle.js. Fake timers so the 5-minute clock is driven
// deterministically — no test ever waits real minutes (same pattern
// as lib/disconnectGrace.js, whose tests use short injected
// durations; here the durations stay real and the clock is fake).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  IDLE_TIMEOUT_MS,
  IDLE_WARNING_MS,
  createMusicIdle
} = require('../lib/musicIdle');

// A controllable clock: setTimeoutFn/clearTimeoutFn pair plus
// advance(ms), which fires every timer whose deadline passed, in
// due order. A callback may arm a new timer (the warning arms the
// disconnect); newly due timers fire on the next advance.
const createFakeTimers = () => {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { due, fn }
  const setTimeoutFn = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { due: now + ms, fn });
    return id;
  };
  const clearTimeoutFn = (id) => { timers.delete(id); };
  const advance = (ms) => {
    now += ms;
    const due = [...timers.entries()]
      .filter(([, t]) => t.due <= now)
      .sort((a, b) => a[1].due - b[1].due);
    for (const [id, t] of due) {
      if (!timers.has(id)) continue; // cancelled by an earlier callback
      timers.delete(id);
      t.fn();
    }
  };
  return { setTimeoutFn, clearTimeoutFn, advance, pending: () => timers.size };
};

const ROOM = 'room1';

const makeIdle = (events) => {
  const timers = createFakeTimers();
  const idle = createMusicIdle({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onWarning: (roomId) => events.push({ event: 'warning', roomId }),
    onTimeout: (roomId) => events.push({ event: 'timeout', roomId })
  });
  return { idle, timers, events };
};

test('timer starts when alone + active, and nothing fires early', () => {
  const { idle, timers, events } = makeIdle([]);
  assert.equal(idle.evaluate(ROOM, { active: true, alone: true }), true);
  assert.equal(idle.has(ROOM), true);
  assert.equal(idle.pendingCount(), 1);
  timers.advance(IDLE_WARNING_MS - 1000);
  assert.deepEqual(events, []);
});

test('no timer when listeners are present', () => {
  const { idle } = makeIdle([]);
  assert.equal(idle.evaluate(ROOM, { active: true, alone: false }), false);
  assert.equal(idle.has(ROOM), false);
});

test('no timer when music is inactive', () => {
  const { idle } = makeIdle([]);
  assert.equal(idle.evaluate(ROOM, { active: false, alone: true }), false);
  assert.equal(idle.has(ROOM), false);
});

test('warning fires at 4 minutes, disconnect at 5 minutes, in order', () => {
  const events = [];
  const { idle, timers } = makeIdle(events);
  idle.evaluate(ROOM, { active: true, alone: true });
  timers.advance(IDLE_WARNING_MS);
  assert.deepEqual(events, [{ event: 'warning', roomId: ROOM }]);
  assert.equal(idle.has(ROOM), true, 'still counting down after the warning');
  timers.advance(IDLE_TIMEOUT_MS - IDLE_WARNING_MS);
  assert.deepEqual(events, [
    { event: 'warning', roomId: ROOM },
    { event: 'timeout', roomId: ROOM }
  ]);
  assert.equal(idle.has(ROOM), false, 'entry is gone after firing');
});

test('a listener joining cancels the timer — no warning, no disconnect', () => {
  const events = [];
  const { idle, timers } = makeIdle(events);
  idle.evaluate(ROOM, { active: true, alone: true });
  timers.advance(2 * 60 * 1000); // 2 minutes alone
  assert.equal(idle.evaluate(ROOM, { active: true, alone: false }), false);
  assert.equal(idle.has(ROOM), false);
  timers.advance(10 * 60 * 1000);
  assert.deepEqual(events, []);
});

test('music stopping cancels the timer', () => {
  const events = [];
  const { idle, timers } = makeIdle(events);
  idle.evaluate(ROOM, { active: true, alone: true });
  assert.equal(idle.evaluate(ROOM, { active: false, alone: true }), false);
  timers.advance(10 * 60 * 1000);
  assert.deepEqual(events, []);
});

test('re-evaluating while pending does NOT restart the clock', () => {
  const events = [];
  const { idle, timers } = makeIdle(events);
  idle.evaluate(ROOM, { active: true, alone: true });
  timers.advance(3 * 60 * 1000); // 3 minutes in
  idle.evaluate(ROOM, { active: true, alone: true }); // another mutation
  timers.advance(60 * 1000); // 4 minutes from the original start
  assert.deepEqual(events, [{ event: 'warning', roomId: ROOM }],
    'warning fires on the original schedule, not 4 minutes after the re-evaluate');
});

test('cancel returns whether a timer was pending; clearAll drops every room', () => {
  const { idle } = makeIdle([]);
  assert.equal(idle.cancel(ROOM), false);
  idle.evaluate(ROOM, { active: true, alone: true });
  idle.evaluate('room2', { active: true, alone: true });
  assert.equal(idle.pendingCount(), 2);
  assert.equal(idle.cancel(ROOM), true);
  assert.equal(idle.pendingCount(), 1);
  idle.clearAll();
  assert.equal(idle.pendingCount(), 0);
});

test('injected short durations are honored (the socket-test seam)', () => {
  const events = [];
  const timers = createFakeTimers();
  const idle = createMusicIdle({
    timeoutMs: 120,
    warningMs: 60,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onWarning: (roomId) => events.push({ event: 'warning', roomId }),
    onTimeout: (roomId) => events.push({ event: 'timeout', roomId })
  });
  idle.evaluate(ROOM, { active: true, alone: true });
  timers.advance(60);
  assert.deepEqual(events, [{ event: 'warning', roomId: ROOM }]);
  timers.advance(60);
  assert.deepEqual(events, [
    { event: 'warning', roomId: ROOM },
    { event: 'timeout', roomId: ROOM }
  ]);
});

test('rooms are independent — one room firing does not touch another', () => {
  const events = [];
  const { idle, timers } = makeIdle(events);
  idle.evaluate('room1', { active: true, alone: true });
  idle.evaluate('room2', { active: true, alone: true });
  timers.advance(IDLE_WARNING_MS);
  idle.cancel('room2');
  timers.advance(IDLE_TIMEOUT_MS - IDLE_WARNING_MS);
  assert.deepEqual(events, [
    { event: 'warning', roomId: 'room1' },
    { event: 'warning', roomId: 'room2' },
    { event: 'timeout', roomId: 'room1' }
  ]);
  assert.equal(idle.has('room2'), false);
});
