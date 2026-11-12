// Tests for the Together-mode client timer derivation
// (frontend/src/focusTimer.js). Pure functions — the client derives
// remaining time from the server's startedAt + durationSec, so these
// prove every client counts down in sync, including late joiners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOCUS_PRESET_MINUTES,
  remainingMs,
  remainingSec,
  focusProgress,
  isFocusActive,
  formatFocusRemaining
} from '../frontend/src/focusTimer.js';

const T0 = 1_000_000_000_000;
const D25 = 25 * 60; // seconds
const session = { roomId: 'room-1', startedAt: T0, durationSec: D25 };

test('remainingMs counts down from startedAt and never goes negative', () => {
  assert.equal(remainingMs(session, T0), D25 * 1000);
  assert.equal(remainingMs(session, T0 + 60_000), (D25 - 60) * 1000);
  // Late joiner, 10 minutes in: 15 minutes left, same as everyone else.
  assert.equal(remainingMs(session, T0 + 600_000), 15 * 60 * 1000);
  assert.equal(remainingMs(session, T0 + D25 * 1000), 0);
  assert.equal(remainingMs(session, T0 + D25 * 1000 + 60_000), 0);
  assert.equal(remainingMs(null, T0), 0);
});

test('remainingSec rounds up so a fresh session reads 25:00, not 24:59', () => {
  assert.equal(remainingSec(session, T0), 1500);
  assert.equal(remainingSec(session, T0 + 500), 1500);
  assert.equal(remainingSec(session, T0 + 1000), 1499);
  assert.equal(remainingSec(session, T0 + D25 * 1000), 0);
});

test('focusProgress runs 0 → 0.5 → 1 and clamps past the end', () => {
  assert.equal(focusProgress(session, T0), 0);
  assert.equal(focusProgress(session, T0 + (D25 * 1000) / 2), 0.5);
  assert.equal(focusProgress(session, T0 + D25 * 1000), 1);
  assert.equal(focusProgress(session, T0 + D25 * 1000 + 60_000), 1);
  assert.equal(focusProgress(null, T0), 0);
});

test('isFocusActive is true until exactly endsAt, then false', () => {
  assert.equal(isFocusActive(session, T0), true);
  assert.equal(isFocusActive(session, T0 + D25 * 1000 - 1), true);
  assert.equal(isFocusActive(session, T0 + D25 * 1000), false);
  assert.equal(isFocusActive(null, T0), false);
});

test('formatFocusRemaining: M:SS under an hour, H:MM:SS past it', () => {
  assert.equal(formatFocusRemaining(0), '0:00');
  assert.equal(formatFocusRemaining(1000), '0:01');
  assert.equal(formatFocusRemaining(59_000), '0:59');
  assert.equal(formatFocusRemaining(59_500), '1:00'); // rounds up
  assert.equal(formatFocusRemaining(90_000), '1:30');
  assert.equal(formatFocusRemaining(5 * 60_000), '5:00');
  assert.equal(formatFocusRemaining(25 * 60_000), '25:00');
  assert.equal(formatFocusRemaining(60 * 60_000), '1:00:00');
  assert.equal(formatFocusRemaining(65 * 60_000), '1:05:00');
  assert.equal(formatFocusRemaining(2 * 60 * 60_000), '2:00:00');
  assert.equal(formatFocusRemaining(-5000), '0:00');
});

test('preset durations are 15/25/45/60 minutes', () => {
  assert.deepEqual(FOCUS_PRESET_MINUTES, [15, 25, 45, 60]);
});
