// Tests for the v0.9.0 density pure helpers (frontend/src/activityStats.js):
// the streak strip's week math and the "Recently quiet" room split.
// No React, no DOM — the functions take plain data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekActivity, roomLastActive, quietRooms } from '../frontend/src/activityStats.js';

const DAY = 24 * 60 * 60 * 1000;
// Fixed "now": Saturday 2026-11-14 12:00 UTC, so the 7-day window is
// Sun 2026-11-08 .. Sat 2026-11-14 and weekday letters are stable.
const NOW = new Date('2026-11-14T12:00:00Z');

test('weekActivity: counts active days and lists one dot per day', () => {
  const r = weekActivity(['2026-11-12', '2026-11-13', '2026-11-14'], NOW);
  assert.equal(r.count, 3);
  assert.equal(r.days.length, 7);
  assert.deepEqual(r.days.map((d) => d.date), [
    '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11',
    '2026-11-12', '2026-11-13', '2026-11-14'
  ]);
  assert.deepEqual(r.days.map((d) => d.active), [false, false, false, false, true, true, true]);
});

test('weekActivity: streak counts back from today', () => {
  assert.equal(weekActivity(['2026-11-12', '2026-11-13', '2026-11-14'], NOW).streak, 3);
  assert.equal(weekActivity(['2026-11-13', '2026-11-14'], NOW).streak, 2);
  // A gap breaks the streak even when the week had activity.
  assert.equal(weekActivity(['2026-11-10', '2026-11-11', '2026-11-14'], NOW).streak, 1);
});

test('weekActivity: today not active yet does not break the streak', () => {
  // Active Thu + Fri, nothing today (Sat): the streak is 2, not 0 —
  // the day is still in progress.
  const r = weekActivity(['2026-11-12', '2026-11-13'], NOW);
  assert.equal(r.count, 2);
  assert.equal(r.streak, 2);
});

test('weekActivity: empty and missing input is a quiet week, not a crash', () => {
  for (const input of [[], null, undefined]) {
    const r = weekActivity(input, NOW);
    assert.equal(r.count, 0);
    assert.equal(r.streak, 0);
    assert.equal(r.days.length, 7);
    assert.ok(r.days.every((d) => d.active === false));
  }
});

test('weekActivity: days outside the window do not count', () => {
  const r = weekActivity(['2026-11-01', '2026-11-07', '2026-11-14'], NOW);
  assert.equal(r.count, 1);
  assert.equal(r.streak, 1);
});

test('roomLastActive: lastActiveAt wins, createdAt is the legacy fallback', () => {
  assert.equal(
    roomLastActive({ lastActiveAt: '2026-11-10T00:00:00Z', createdAt: '2026-11-01T00:00:00Z' }).toISOString(),
    '2026-11-10T00:00:00.000Z'
  );
  assert.equal(
    roomLastActive({ createdAt: '2026-11-01T00:00:00Z' }).toISOString(),
    '2026-11-01T00:00:00.000Z'
  );
  assert.equal(roomLastActive({}), null);
  assert.equal(roomLastActive(null), null);
  assert.equal(roomLastActive({ lastActiveAt: 'not-a-date' }), null);
});

const room = (overrides) => ({
  id: overrides.id || 'r1',
  occupantCount: 0,
  createdAt: '2026-11-01T00:00:00Z',
  ...overrides
});

test('quietRooms: empty + inactive 7+ days is quiet; live is never quiet', () => {
  const rooms = [
    room({ id: 'quiet-old', lastActiveAt: '2026-11-06T12:00:00Z' }), // 8 days ago
    room({ id: 'recent', lastActiveAt: '2026-11-10T12:00:00Z' }), // 4 days ago
    room({ id: 'live', occupantCount: 2, lastActiveAt: '2026-10-01T00:00:00Z' }),
    room({ id: 'legacy-new', createdAt: '2026-11-12T00:00:00Z' }) // no lastActiveAt, created 2 days ago
  ];
  assert.deepEqual(quietRooms(rooms, NOW).map((r) => r.id), ['quiet-old']);
});

test('quietRooms: the 7-day boundary is exclusive — exactly 7 days is not quiet', () => {
  const rooms = [room({ id: 'edge', lastActiveAt: '2026-11-07T12:00:00Z' })];
  assert.deepEqual(quietRooms(rooms, NOW), []);
});

test('quietRooms: a room with no timestamp at all stays in the main list', () => {
  const rooms = [{ id: 'mystery', occupantCount: 0 }];
  assert.deepEqual(quietRooms(rooms, NOW), []);
});

test('quietRooms: a legacy room created 8+ days ago reads as quiet via createdAt', () => {
  const rooms = [room({ id: 'legacy-old', createdAt: '2026-11-01T00:00:00Z' })];
  assert.deepEqual(quietRooms(rooms, NOW).map((r) => r.id), ['legacy-old']);
});
