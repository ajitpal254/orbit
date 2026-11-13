// Tests for the disconnect-grace registry (lib/disconnectGrace.js).
// Pure: driven with a fake clock, no socket.io, no DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DISCONNECT_GRACE_MS, graceKey, createDisconnectGrace } = require('../lib/disconnectGrace');

// Controllable clock: arm() schedules into `scheduled`; runDue(ms)
// fires everything whose time has come, in order.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map(); // id -> { at, fn }
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      scheduled.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) { scheduled.delete(id); },
    runDue(ms) {
      now += ms;
      const due = [...scheduled.entries()]
        .filter(([, s]) => s.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, s] of due) {
        scheduled.delete(id);
        s.fn();
      }
      return due.length;
    },
    pendingCount: () => scheduled.size
  };
}

const grace = (clock, graceMs = 1000) => createDisconnectGrace({
  graceMs,
  setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
  clearTimeoutFn: (id) => clock.clearTimeout(id)
});

test('grace key is user:room', () => {
  assert.equal(graceKey('u1', 'r1'), 'u1:r1');
});

test('expiry fires after the grace with the departed socket', () => {
  const clock = fakeClock();
  const g = grace(clock, 1000);
  const fired = [];
  g.arm('u1', 'r1', 's1', (ctx) => fired.push(ctx));
  assert.equal(fired.length, 0);
  assert.equal(g.has('u1', 'r1'), true);
  clock.runDue(999);
  assert.equal(fired.length, 0, 'must not fire before the grace elapses');
  clock.runDue(1);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0], { userId: 'u1', roomId: 'r1', socketIds: ['s1'] });
  assert.equal(g.has('u1', 'r1'), false);
  assert.equal(g.pendingCount(), 0);
});

test('cancel returns the pending sockets and never fires', () => {
  const clock = fakeClock();
  const g = grace(clock, 1000);
  const fired = [];
  g.arm('u1', 'r1', 's1', (ctx) => fired.push(ctx));
  const cancelled = g.cancel('u1', 'r1');
  assert.deepEqual(cancelled, { userId: 'u1', roomId: 'r1', socketIds: ['s1'] });
  assert.equal(g.cancel('u1', 'r1'), null, 'second cancel is a no-op');
  clock.runDue(5000);
  assert.equal(fired.length, 0);
  assert.equal(clock.pendingCount(), 0);
});

test('a second drop in the same room merges into one timer', () => {
  const clock = fakeClock();
  const g = grace(clock, 1000);
  const fired = [];
  g.arm('u1', 'r1', 's1', (ctx) => fired.push(ctx));
  g.arm('u1', 'r1', 's2', (ctx) => fired.push(ctx));
  assert.equal(g.pendingCount(), 1, 'one timer for both sockets');
  assert.equal(clock.pendingCount(), 1);
  clock.runDue(1000);
  assert.equal(fired.length, 1, 'one expiry for the merged entry');
  assert.deepEqual(fired[0].socketIds.sort(), ['s1', 's2']);
});

test('different rooms and users arm independently', () => {
  const clock = fakeClock();
  const g = grace(clock, 1000);
  const fired = [];
  g.arm('u1', 'r1', 's1', (ctx) => fired.push(['r1', ctx.socketIds]));
  g.arm('u1', 'r2', 's2', (ctx) => fired.push(['r2', ctx.socketIds]));
  g.arm('u2', 'r1', 's3', (ctx) => fired.push(['u2', ctx.socketIds]));
  assert.equal(g.pendingCount(), 3);
  clock.runDue(1000);
  assert.equal(fired.length, 3);
  assert.equal(g.pendingCount(), 0);
});

test('clearAll drops every pending timer', () => {
  const clock = fakeClock();
  const g = grace(clock, 1000);
  const fired = [];
  g.arm('u1', 'r1', 's1', () => fired.push(1));
  g.arm('u2', 'r2', 's2', () => fired.push(2));
  g.clearAll();
  assert.equal(g.pendingCount(), 0);
  clock.runDue(5000);
  assert.equal(fired.length, 0);
});

test('default grace is 15s', () => {
  assert.equal(DISCONNECT_GRACE_MS, 15000);
});
