// Tests for the ICE recovery state machine
// (frontend/src/iceRecovery.js, ESM). Time is injected — no timers,
// no RTCPeerConnection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ICE_DISCONNECTED_GRACE_MS,
  ICE_RESTART_TIMEOUT_MS,
  createIceRecovery,
  iceRecoveryStep
} from '../frontend/src/iceRecovery.js';

const step = (machine, iceState, now) => iceRecoveryStep(machine, iceState, now);

test('grace constants: 2s before restart, 10s restart timeout', () => {
  assert.equal(ICE_DISCONNECTED_GRACE_MS, 2000);
  assert.equal(ICE_RESTART_TIMEOUT_MS, 10000);
});

test('connected stays stable and does nothing', () => {
  const m = createIceRecovery();
  assert.deepEqual(step(m, 'connected', 0), { machine: { phase: 'stable', since: null, recreated: false }, action: 'none' });
  assert.deepEqual(step(m, 'checking', 0).action, 'none');
  assert.deepEqual(step(m, 'new', 0).action, 'none');
});

test('disconnected waits out the grace, then restarts ICE', () => {
  let m = createIceRecovery();
  let r = step(m, 'disconnected', 1000);
  assert.equal(r.action, 'none');
  assert.equal(r.machine.phase, 'waiting');
  m = r.machine;
  // Still inside the grace: nothing.
  r = step(m, 'disconnected', 1000 + ICE_DISCONNECTED_GRACE_MS - 1);
  assert.equal(r.action, 'none');
  assert.equal(r.machine.phase, 'waiting');
  // Grace elapsed: restart ICE.
  r = step(m, 'disconnected', 1000 + ICE_DISCONNECTED_GRACE_MS);
  assert.equal(r.action, 'restart-ice');
  assert.equal(r.machine.phase, 'restarting');
});

test('recovering to connected resets the budget', () => {
  let m = createIceRecovery();
  m = step(m, 'disconnected', 1000).machine;
  m = step(m, 'disconnected', 1000 + ICE_DISCONNECTED_GRACE_MS).machine;
  assert.equal(m.phase, 'restarting');
  const r = step(m, 'connected', 5000);
  assert.equal(r.action, 'none');
  assert.deepEqual(r.machine, { phase: 'stable', since: null, recreated: false });
  // A later blip gets a fresh grace + restart, not an instant give-up.
  const r2 = step(r.machine, 'disconnected', 6000);
  assert.equal(r2.action, 'none');
  assert.equal(r2.machine.phase, 'waiting');
});

test('a restart that never recovers recreates the peer once', () => {
  let m = createIceRecovery();
  m = step(m, 'disconnected', 1000).machine;
  m = step(m, 'disconnected', 1000 + ICE_DISCONNECTED_GRACE_MS).machine;
  assert.equal(m.phase, 'restarting');
  // 'checking' during the restart is progress, not a transition.
  let r = step(m, 'checking', 5000);
  assert.equal(r.action, 'none');
  assert.equal(r.machine.phase, 'restarting');
  // Still disconnected past the restart timeout: full reconnect.
  r = step(m, 'disconnected', 1000 + ICE_DISCONNECTED_GRACE_MS + ICE_RESTART_TIMEOUT_MS);
  assert.equal(r.action, 'recreate-peer');
  assert.equal(r.machine.recreated, true);
  assert.equal(r.machine.phase, 'stable');
});

test('failed skips the grace and recreates at once', () => {
  const m = createIceRecovery();
  const r = step(m, 'failed', 1000);
  assert.equal(r.action, 'recreate-peer');
  assert.equal(r.machine.recreated, true);
});

test('a second failure after the recreate gives up', () => {
  let m = createIceRecovery();
  m = step(m, 'failed', 1000).machine; // recreate #1
  assert.equal(m.recreated, true);
  // The fresh pc disconnects again: grace, restart, then give up.
  m = step(m, 'disconnected', 2000).machine;
  assert.equal(m.phase, 'waiting');
  m = step(m, 'disconnected', 2000 + ICE_DISCONNECTED_GRACE_MS).machine;
  assert.equal(m.phase, 'restarting');
  const r = step(m, 'disconnected', 2000 + ICE_DISCONNECTED_GRACE_MS + ICE_RESTART_TIMEOUT_MS);
  assert.equal(r.action, 'give-up');
  assert.equal(r.machine.phase, 'done');
  // Terminal: further events do nothing.
  assert.equal(step(r.machine, 'failed', 99999).action, 'none');
});

test('failed after the recreate also gives up at once', () => {
  let m = createIceRecovery();
  m = step(m, 'failed', 1000).machine; // recreate #1
  const r = step(m, 'failed', 2000);
  assert.equal(r.action, 'give-up');
  assert.equal(r.machine.phase, 'done');
});

test('closed ends the machine with no action', () => {
  let m = createIceRecovery();
  m = step(m, 'disconnected', 1000).machine;
  const r = step(m, 'closed', 2000);
  assert.equal(r.action, 'none');
  assert.equal(r.machine.phase, 'done');
});

test('the machine never mutates its input', () => {
  const m = createIceRecovery();
  const snapshot = { ...m };
  step(m, 'disconnected', 1000);
  assert.deepEqual(m, snapshot);
});
