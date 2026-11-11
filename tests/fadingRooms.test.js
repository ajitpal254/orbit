// Tests for fading rooms ("campfires", lib/fadingRooms.js + the
// ephemeral/expiresAt/status fields on the Room model + the
// ephemeral flag in validateRoomInput).
// Pure logic + stub-model transitions — no MongoDB needed, and no
// real 60s waits: every boundary uses fixed dates.
//
// Rules under test (playbook item 4 + addendum §2):
// - a campfire fades 60s after presence empties (expiresAt = now + 60s);
// - expired means expiresAt is AT or BEFORE now (at == gone);
// - legacy rooms with no ephemeral/expiresAt stay permanent, never crash;
// - arm/clear/keep/cleanup-claim are atomic conditional updates: only
//   one transition wins, and a lost race returns null / does nothing;
// - cleanup is idempotent: a second run, a lost claim race, and a
//   crashed run's leftover `closed` room are all safe.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FADE_AFTER_MS, FADE_WORKER_INTERVAL_MS, expiryFor, isExpired,
  isVisible, isCampfire, aliveFilter, dueFilter,
  armExpiry, clearExpiry, keepRoom, runCleanup, startCleanupWorker
} = require('../lib/fadingRooms');
const { validateRoomInput } = require('../lib/rooms');
const Room = require('../models/Room');

const T = new Date('2026-11-11T12:00:00Z'); // fixed "now"
const SECOND = 1000;
const at = (ms) => new Date(T.getTime() + ms);
const campfire = (expiresAt, extra = {}) =>
  ({ ephemeral: true, status: 'open', ...(expiresAt === undefined ? {} : { expiresAt }), ...extra });
const legacy = (extra = {}) => ({ name: 'Old Room', ...extra });

test('FADE_AFTER_MS is exactly 60s; worker sweeps every 15s', () => {
  assert.equal(FADE_AFTER_MS, 60 * 1000);
  assert.equal(FADE_WORKER_INTERVAL_MS, 15 * 1000);
});

test('expiryFor: emptiedAt + 60s exactly', () => {
  assert.equal(expiryFor(T).toISOString(), '2026-11-11T12:01:00.000Z');
  assert.equal(expiryFor(new Date('2026-01-01T00:00:00Z')).toISOString(), '2026-01-01T00:01:00.000Z');
});

test('boundary: 59s visible, 60s gone, 61s gone (expiresAt itself)', () => {
  const room = campfire(expiryFor(T)); // expires T + 60s
  assert.equal(isVisible(room, at(59 * SECOND)), true);
  assert.equal(isVisible(room, at(60 * SECOND)), false); // exactly at
  assert.equal(isVisible(room, at(61 * SECOND)), false);
  assert.equal(isExpired(room, at(59 * SECOND)), false);
  assert.equal(isExpired(room, at(60 * SECOND)), true);
  assert.equal(isExpired(room, at(61 * SECOND)), true);
});

test('boundary: just-before / at / just-after expiry on expiresAt itself', () => {
  assert.equal(isExpired(campfire(at(-1000)), T), true);
  assert.equal(isExpired(campfire(at(0)), T), true); // at == expired
  assert.equal(isExpired(campfire(at(1000)), T), false);
  assert.equal(isVisible(campfire(at(0)), T), false);
  assert.equal(isVisible(campfire(at(1000)), T), true);
});

test('legacy rooms with NO ephemeral/expiresAt keep working (visible, no crash)', () => {
  assert.equal(isExpired(legacy(), T), false);
  assert.equal(isVisible(legacy(), T), true);
  assert.equal(isExpired(legacy({ expiresAt: null }), T), false);
  assert.equal(isVisible(legacy({ expiresAt: null }), T), true);
  assert.equal(isExpired(legacy({ status: undefined }), T), false);
  assert.equal(isExpired(null, T), false);
  assert.equal(isExpired(undefined, T), false);
  assert.equal(isVisible(null, T), false); // no room at all is not visible
  assert.equal(isVisible(undefined, T), false);
  assert.equal(isCampfire(legacy()), false);
  assert.equal(isCampfire(campfire(at(1000))), true);
  assert.equal(isCampfire({ ephemeral: false }), false);
  assert.equal(isCampfire(null), false);
});

test('a cleanup-claimed room (status closed) is not visible even before its deadline', () => {
  assert.equal(isVisible(campfire(at(60 * SECOND), { status: 'closed' }), T), false);
  assert.equal(isVisible(campfire(undefined, { status: 'closed' }), T), false);
  // ...but an open campfire with no deadline yet is visible.
  assert.equal(isVisible(campfire(undefined), T), true);
});

test('aliveFilter: legacy arm + strict $gt arm + not-closed, at-or-before excluded', () => {
  const filter = aliveFilter(T);
  assert.deepEqual(filter, {
    status: { $ne: 'closed' },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: T } }]
  });
  // Simulate the fragment's Mongo semantics over fixtures.
  const matches = (doc) =>
    doc.status !== 'closed' && (doc.expiresAt == null || new Date(doc.expiresAt) > T);
  assert.equal(matches(legacy()), true); // legacy: no fields at all
  assert.equal(matches(legacy({ expiresAt: null })), true);
  assert.equal(matches(campfire(at(1000))), true); // live campfire
  assert.equal(matches(campfire(at(-1000))), false); // expired
  assert.equal(matches(campfire(at(0))), false); // at == expired ($gt, not $gte)
  assert.equal(matches(campfire(at(1000), { status: 'closed' })), false);
  // The filter and the pure helper agree on every fixture.
  const fixtures = [
    legacy(), legacy({ expiresAt: null }), campfire(at(1000)),
    campfire(at(-1000)), campfire(at(0)),
    campfire(at(1000), { status: 'closed' }), campfire(undefined)
  ];
  assert.deepEqual(fixtures.map((r) => matches(r)), fixtures.map((r) => isVisible(r, T)));
});

test('dueFilter: only open campfires whose deadline has passed', () => {
  const filter = dueFilter(T);
  assert.deepEqual(filter, {
    ephemeral: true,
    status: { $ne: 'closed' },
    expiresAt: { $lte: T }
  });
  const matches = (doc) =>
    doc.ephemeral === true && doc.status !== 'closed' &&
    doc.expiresAt != null && new Date(doc.expiresAt) <= T;
  assert.equal(matches(campfire(at(-1000))), true);
  assert.equal(matches(campfire(at(0))), true); // at == due
  assert.equal(matches(campfire(at(1000))), false); // not yet
  assert.equal(matches(campfire(undefined)), false); // never armed
  assert.equal(matches(campfire(at(-1000), { status: 'closed' })), false);
  assert.equal(matches(legacy({ expiresAt: at(-1000) })), false); // not a campfire
  assert.equal(matches({ ephemeral: true, expiresAt: at(-1000) }), true); // missing status counts as open
});

test('validateRoomInput: ephemeral only on explicit true; old clients stay permanent', () => {
  assert.equal(validateRoomInput({ name: 'Room', ephemeral: true }).room.ephemeral, true);
  assert.equal(validateRoomInput({ name: 'Room' }).room.ephemeral, false);
  assert.equal(validateRoomInput({ name: 'Room', ephemeral: false }).room.ephemeral, false);
  assert.equal(validateRoomInput({ name: 'Room', ephemeral: 'true' }).room.ephemeral, false);
  assert.equal(validateRoomInput({ name: 'Room', ephemeral: 1 }).room.ephemeral, false);
});

test('models: Room has ephemeral / expiresAt / status / closedAt + worker index', () => {
  assert.equal(Room.schema.path('ephemeral').instance, 'Boolean');
  assert.equal(Room.schema.path('ephemeral').defaultValue, false);
  assert.equal(Room.schema.path('expiresAt').instance, 'Date');
  assert.equal(Room.schema.path('status').instance, 'String');
  assert.equal(Room.schema.path('status').defaultValue, 'open');
  assert.deepEqual(Room.schema.path('status').enumValues, ['open', 'closed']);
  assert.equal(Room.schema.path('closedAt').instance, 'Date');
  const idx = Room.schema.indexes().find(([spec]) =>
    spec.ephemeral === 1 && spec.status === 1 && spec.expiresAt === 1);
  assert.ok(idx, 'Room is missing the { ephemeral, status, expiresAt } worker index');
});

test('models: a campfire doc validates; a legacy doc validates too', async () => {
  const oid = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const fire = new Room({
    name: 'Late Night', createdBy: oid,
    ephemeral: true, expiresAt: expiryFor(T), status: 'open'
  });
  await fire.validate();
  assert.equal(fire.ephemeral, true);
  assert.ok(fire.expiresAt instanceof Date);
  const old = new Room({ name: 'Old Room', createdBy: oid });
  await old.validate();
  assert.equal(old.ephemeral, false);
  assert.equal(old.expiresAt, null);
  assert.equal(old.status, 'open');
  const bad = new Room({ name: 'Bad', createdBy: oid, status: 'bogus' });
  await assert.rejects(bad.validate(), /status/);
});

// --- Atomic transitions, against a recording stub model ---

const recordingModel = () => {
  const calls = [];
  return {
    calls,
    findOneAndUpdate: async (filter, update, opts) => {
      calls.push({ filter, update, opts });
      return { _id: 'room-id', ...update.$set };
    }
  };
};

test('armExpiry: conditional update — campfire + open + not already armed, sets now + 60s', async () => {
  const M = recordingModel();
  const out = await armExpiry(M, 'room-id', T);
  assert.equal(M.calls.length, 1);
  assert.deepEqual(M.calls[0].filter, {
    _id: 'room-id', ephemeral: true, status: { $ne: 'closed' }, expiresAt: null
  });
  assert.deepEqual(M.calls[0].update, { $set: { expiresAt: expiryFor(T) } });
  assert.deepEqual(M.calls[0].opts, { returnDocument: 'after' });
  assert.equal(out.expiresAt.toISOString(), '2026-11-11T12:01:00.000Z');
});

test('clearExpiry: conditional update — only when an expiry is set', async () => {
  const M = recordingModel();
  await clearExpiry(M, 'room-id');
  assert.deepEqual(M.calls[0].filter, {
    _id: 'room-id', ephemeral: true, expiresAt: { $ne: null }
  });
  assert.deepEqual(M.calls[0].update, { $unset: { expiresAt: '' } });
});

test('keepRoom: conditional update — open campfire, not yet expired; makes it permanent', async () => {
  const M = recordingModel();
  await keepRoom(M, 'room-id', T);
  assert.deepEqual(M.calls[0].filter, {
    _id: 'room-id',
    ephemeral: true,
    status: { $ne: 'closed' },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: T } }]
  });
  assert.deepEqual(M.calls[0].update, {
    $set: { ephemeral: false }, $unset: { expiresAt: '' }
  });
});

test('transitions return null when the conditional update matches nothing (lost race)', async () => {
  const losing = {
    findOneAndUpdate: async () => null
  };
  assert.equal(await armExpiry(losing, 'room-id', T), null);
  assert.equal(await clearExpiry(losing, 'room-id'), null);
  assert.equal(await keepRoom(losing, 'room-id', T), null);
});

// --- Cleanup worker, against stub models ---

const stubModels = ({ due = [], closed = [], claim = { _id: 'r1', name: 'Late Night' }, deleteCount = 1 } = {}) => {
  const calls = [];
  const RoomStub = {
    calls,
    find: async (filter) => {
      calls.push(['find', filter]);
      // The worker asks for due campfires first, then closed leftovers.
      if (filter && filter.ephemeral === true) return due;
      if (filter && filter.status === 'closed') return closed;
      return [];
    },
    findOneAndUpdate: async (filter, update, opts) => {
      calls.push(['findOneAndUpdate', filter, update, opts]);
      return claim;
    },
    deleteOne: async (filter) => {
      calls.push(['deleteOne', filter]);
      return { deletedCount: deleteCount };
    },
    deleteMany: async (filter) => {
      calls.push(['deleteMany', filter]);
      return { deletedCount: 1 };
    }
  };
  const MessageStub = {
    deleteMany: async (filter) => {
      calls.push(['Message.deleteMany', filter]);
      return { deletedCount: 2 };
    }
  };
  const InviteStub = {
    deleteMany: async (filter) => {
      calls.push(['Invite.deleteMany', filter]);
      return { deletedCount: 0 };
    }
  };
  return { RoomStub, MessageStub, InviteStub, calls };
};

test('runCleanup: claims a due campfire atomically, deletes room + chat + invites, notifies once', async () => {
  const dueRoom = { _id: 'r1', name: 'Late Night', ephemeral: true, expiresAt: at(-1000) };
  const { RoomStub, MessageStub, InviteStub, calls } = stubModels({
    due: [dueRoom], closed: [dueRoom]
  });
  const closedIds = [];
  const logs = [];
  let mutedCleared = null;
  const res = await runCleanup({
    Room: RoomStub, Message: MessageStub, RoomInvite: InviteStub,
    clearMutedForRoom: (id) => { mutedCleared = String(id); },
    onClosed: async (room) => { closedIds.push(String(room._id)); },
    log: (fields, msg) => logs.push([fields, msg])
  }, { now: T });
  assert.deepEqual(res, { claimed: 1, deleted: 1 });
  // The due query itself requires ephemeral + deadline passed.
  const dueFind = calls.find(([op, f]) => op === 'find' && f.ephemeral === true);
  assert.deepEqual(dueFind[1], dueFilter(T));
  // The claim re-checks every due condition + the room id, atomically.
  const claim = calls.find(([op]) => op === 'findOneAndUpdate');
  assert.deepEqual(claim[1], { _id: 'r1', ...dueFilter(T) });
  assert.deepEqual(claim[2], { $set: { status: 'closed', closedAt: T } });
  // The delete phase removes the room, its messages and its invites.
  assert.ok(calls.some(([op, f]) => op === 'deleteOne' && f._id === 'r1'));
  assert.ok(calls.some(([op, f]) => op === 'Message.deleteMany' && String(f.roomId) === 'r1'));
  assert.ok(calls.some(([op, f]) => op === 'Invite.deleteMany' && String(f.room) === 'r1'));
  assert.equal(mutedCleared, 'r1');
  assert.deepEqual(closedIds, ['r1']); // notified exactly once
  assert.equal(logs.length, 1); // one audit line
  assert.equal(logs[0][0].roomId, 'r1');
  assert.match(logs[0][1], /faded/i);
});

test('runCleanup is idempotent: a second run with nothing due deletes nothing', async () => {
  const { RoomStub, MessageStub, InviteStub, calls } = stubModels({ due: [], closed: [] });
  let notified = 0;
  const res = await runCleanup({
    Room: RoomStub, Message: MessageStub, RoomInvite: InviteStub,
    onClosed: async () => { notified += 1; }
  }, { now: T });
  assert.deepEqual(res, { claimed: 0, deleted: 0 });
  assert.equal(notified, 0);
  assert.equal(calls.filter(([op]) => op === 'deleteOne').length, 0);
  assert.equal(calls.filter(([op]) => op === 'findOneAndUpdate').length, 0);
});

test('runCleanup: a lost claim race (another worker won) deletes nothing and notifies nobody', async () => {
  const dueRoom = { _id: 'r1', name: 'Late Night', ephemeral: true, expiresAt: at(-1000) };
  const { RoomStub, MessageStub, InviteStub, calls } = stubModels({
    due: [dueRoom], closed: [], claim: null // claim matched nothing
  });
  let notified = 0;
  const res = await runCleanup({
    Room: RoomStub, Message: MessageStub, RoomInvite: InviteStub,
    onClosed: async () => { notified += 1; }
  }, { now: T });
  assert.deepEqual(res, { claimed: 0, deleted: 0 });
  assert.equal(notified, 0);
  assert.equal(calls.filter(([op]) => op === 'deleteOne').length, 0);
});

test('runCleanup: a leftover `closed` room from a crashed run is swept, exactly once', async () => {
  const leftover = { _id: 'r9', name: 'Crashed', ephemeral: true, status: 'closed' };
  const { RoomStub, MessageStub, InviteStub, calls } = stubModels({
    due: [], closed: [leftover]
  });
  let notified = 0;
  const res = await runCleanup({
    Room: RoomStub, Message: MessageStub, RoomInvite: InviteStub,
    onClosed: async () => { notified += 1; }
  }, { now: T });
  assert.deepEqual(res, { claimed: 0, deleted: 1 });
  assert.equal(notified, 1);
  assert.equal(calls.filter(([op]) => op === 'findOneAndUpdate').length, 0); // no claim needed
});

test('runCleanup: deleteOne with deletedCount 0 (other worker deleted first) skips log + notify', async () => {
  const leftover = { _id: 'r9', name: 'Raced', ephemeral: true, status: 'closed' };
  const { RoomStub, MessageStub, InviteStub, calls } = stubModels({
    due: [], closed: [leftover], deleteCount: 0
  });
  let notified = 0;
  const logs = [];
  const res = await runCleanup({
    Room: RoomStub, Message: MessageStub, RoomInvite: InviteStub,
    onClosed: async () => { notified += 1; },
    log: (f, m) => logs.push([f, m])
  }, { now: T });
  assert.deepEqual(res, { claimed: 0, deleted: 0 });
  assert.equal(notified, 0);
  assert.equal(logs.length, 0);
  // Messages/invites are only cleaned up by the worker that deleted the room.
  assert.equal(calls.filter(([op]) => op === 'Message.deleteMany').length, 0);
});

test('runCleanup never asks for legacy rooms: the due query requires ephemeral + a deadline', async () => {
  const { RoomStub, MessageStub, InviteStub, calls } = stubModels({ due: [], closed: [] });
  await runCleanup({ Room: RoomStub, Message: MessageStub, RoomInvite: InviteStub }, { now: T });
  const dueFind = calls.find(([op, f]) => op === 'find' && f.ephemeral === true);
  assert.equal(dueFind[1].ephemeral, true);
  assert.ok(dueFind[1].expiresAt.$lte);
  assert.equal(dueFind[1].expiresAt.$lte.getTime(), T.getTime());
});

test('startCleanupWorker runs once immediately, repeats on the interval, and stops', async () => {
  const { RoomStub, MessageStub, InviteStub } = stubModels({ due: [], closed: [] });
  let finds = 0;
  const countingRoom = {
    ...RoomStub,
    find: async (filter) => { finds += 1; return RoomStub.find(filter); }
  };
  const worker = startCleanupWorker(
    { Room: countingRoom, Message: MessageStub, RoomInvite: InviteStub },
    { intervalMs: 20 }
  );
  // The immediate run lands without waiting for the first interval.
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(finds >= 2, `immediate run should have queried (finds=${finds})`);
  const afterStart = finds;
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(finds > afterStart, 'interval ticks keep sweeping');
  worker.stop();
  const afterStop = finds;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(finds, afterStop, 'no sweeps after stop()');
});
