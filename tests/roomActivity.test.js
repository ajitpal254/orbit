// Tests for the v0.9.0 room-activity backend (lib/roomActivity.js):
// the pure day-bucketing behind GET /api/me/activity, the Room model's
// lastActiveAt field, and that touchRoomActivity never throws. No
// MongoDB needed — validate() runs offline and the touch is
// fire-and-forget by design (its .catch swallows a missing DB).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { activeDaysFromTimestamps, touchRoomActivity } = require('../lib/roomActivity');
const Room = require('../models/Room');

const NOW = new Date('2026-11-14T12:00:00Z');

test('activeDaysFromTimestamps: buckets message times into UTC days, last 7 days only', () => {
  const days = activeDaysFromTimestamps([
    new Date('2026-11-14T09:00:00Z'),
    new Date('2026-11-14T10:30:00Z'), // same day dedupes
    new Date('2026-11-12T23:59:00Z'),
    new Date('2026-11-07T00:00:00Z'), // 7 days back: outside the window
    new Date('2026-11-01T00:00:00Z') // far outside
  ], NOW);
  assert.deepEqual(days, ['2026-11-12', '2026-11-14']);
});

test('activeDaysFromTimestamps: a message at 00:30 on the 7th day back still counts', () => {
  // Calendar days, not milliseconds: 2026-11-08 00:30 is 6 days 11.5h
  // before NOW, but its day is the oldest day in the window.
  const days = activeDaysFromTimestamps([new Date('2026-11-08T00:30:00Z')], NOW);
  assert.deepEqual(days, ['2026-11-08']);
});

test('activeDaysFromTimestamps: accepts ISO strings and skips bad values', () => {
  const days = activeDaysFromTimestamps(['2026-11-13T12:00:00Z', 'not-a-date', null, undefined], NOW);
  assert.deepEqual(days, ['2026-11-13']);
  assert.deepEqual(activeDaysFromTimestamps([], NOW), []);
});

test('Room model: accepts lastActiveAt and keeps it optional (legacy rooms have none)', () => {
  const withStamp = new Room({
    name: 'Late Night',
    createdBy: new mongoose.Types.ObjectId(),
    lastActiveAt: new Date('2026-11-14T00:00:00Z')
  });
  assert.equal(withStamp.validateSync(), undefined);
  assert.equal(withStamp.lastActiveAt.toISOString(), '2026-11-14T00:00:00.000Z');

  const legacy = new Room({ name: 'Old Room', createdBy: new mongoose.Types.ObjectId() });
  assert.equal(legacy.validateSync(), undefined);
  assert.equal(legacy.lastActiveAt, null);
});

test('touchRoomActivity: never throws, even with no database connected', () => {
  assert.doesNotThrow(() => touchRoomActivity('507f1f77bcf86cd799439011'));
  assert.doesNotThrow(() => touchRoomActivity(null));
  assert.doesNotThrow(() => touchRoomActivity(undefined));
});
