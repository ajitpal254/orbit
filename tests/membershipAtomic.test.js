// Tests for atomic member-list mutations (audit M4).
//
// The old read-then-$set writeMembers() could lose an update when two
// membership operations interleaved — a kick silently undone, a join
// silently dropped. These tests run the real operators against
// MongoDB and assert both effects hold under concurrency. They skip
// when no MongoDB is reachable (same pattern as
// tests/emailVerification.test.js); run a local mongod or set
// MONGODB_URI to exercise them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Room = require('../models/Room');
const { normalizeMembers } = require('../lib/roles');
const { addMember, removeMember, setMemberRole, transferOwnership } = require('../lib/membership');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit-test-membership';
let mongoAvailable = false;

const skipIfNoMongo = (t) => {
  if (!mongoAvailable) {
    t.skip('no MongoDB reachable at ' + MONGO_URI);
    return true;
  }
  return false;
};

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    mongoAvailable = true;
    await mongoose.connection.db.dropDatabase();
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
});

const oid = () => new mongoose.Types.ObjectId();

const makeRoom = async (members) => Room.create({
  name: 'Room', createdBy: members[0].user, isPrivate: true, members
});

const memberIds = async (roomId) => {
  const room = await Room.findById(roomId).lean();
  return normalizeMembers(room).map((m) => m.userId);
};

const rolesOf = async (roomId) => {
  const room = await Room.findById(roomId).lean();
  return new Map(normalizeMembers(room).map((m) => [m.userId, m.role]));
};

test('addMember adds once; a duplicate add is a no-op (matchedCount 0)', async (t) => {
  if (skipIfNoMongo(t)) return;
  const owner = oid(), x = oid(), y = oid();
  const room = await makeRoom([
    { user: owner, role: 'owner' }, { user: x, role: 'member' }
  ]);
  const first = await addMember(Room, room._id, y, 'member');
  assert.equal(first.matchedCount, 1);
  assert.equal(first.modifiedCount, 1);
  const dup = await addMember(Room, room._id, y, 'member');
  assert.equal(dup.matchedCount, 0, 'already a member: the $ne filter must not match');
  assert.deepEqual((await memberIds(room._id)).sort(), [String(owner), String(x), String(y)].sort());
});

test('addMember to a legacy plain-id room never duplicates the member', async (t) => {
  if (skipIfNoMongo(t)) return;
  const owner = oid(), x = oid(), y = oid();
  const { insertedId } = await Room.collection.insertOne({
    name: 'Legacy', createdBy: owner, isPrivate: true,
    members: [owner, x], createdAt: new Date(), updatedAt: new Date()
  });
  const res = await addMember(Room, insertedId, y, 'member');
  assert.equal(res.matchedCount, 1);
  const ids = await memberIds(insertedId);
  assert.equal(ids.length, 3, 'normalized view de-duplicates');
  assert.deepEqual(ids.sort(), [String(owner), String(x), String(y)].sort());
});

test('removeMember removes subdocument and legacy plain-id entries in one op', async (t) => {
  if (skipIfNoMongo(t)) return;
  const owner = oid(), x = oid(), y = oid();
  const room = await makeRoom([
    { user: owner, role: 'owner' }, { user: x, role: 'member' }, { user: y, role: 'member' }
  ]);
  const removed = await removeMember(Room, room._id, y);
  assert.equal(removed.matchedCount, 1);
  assert.deepEqual((await memberIds(room._id)).sort(), [String(owner), String(x)].sort());

  const { insertedId } = await Room.collection.insertOne({
    name: 'Legacy', createdBy: owner, isPrivate: true,
    members: [owner, x, y], createdAt: new Date(), updatedAt: new Date()
  });
  await removeMember(Room, insertedId, x);
  assert.deepEqual((await memberIds(insertedId)).sort(), [String(owner), String(y)].sort());
});

test('setMemberRole promotes/demotes once; a stale second attempt gets null', async (t) => {
  if (skipIfNoMongo(t)) return;
  const owner = oid(), x = oid();
  const room = await makeRoom([
    { user: owner, role: 'owner' }, { user: x, role: 'member' }
  ]);
  const promoted = await setMemberRole(Room, room._id, x, 'member', 'moderator');
  assert.ok(promoted, 'first promote wins');
  assert.equal((await rolesOf(room._id)).get(String(x)), 'moderator');
  assert.equal(await setMemberRole(Room, room._id, x, 'member', 'moderator'), null,
    'second promote with the stale expected role must miss');
  const demoted = await setMemberRole(Room, room._id, x, 'moderator', 'member');
  assert.ok(demoted, 'demote wins from the current role');
  assert.equal((await rolesOf(room._id)).get(String(x)), 'member');
});

test('setMemberRole promotes a legacy plain-id member into a subdocument', async (t) => {
  if (skipIfNoMongo(t)) return;
  const owner = oid(), x = oid();
  const { insertedId } = await Room.collection.insertOne({
    name: 'Legacy', createdBy: owner, isPrivate: true,
    members: [owner, x], createdAt: new Date(), updatedAt: new Date()
  });
  const promoted = await setMemberRole(Room, insertedId, x, 'member', 'moderator');
  assert.ok(promoted, 'legacy promote must match');
  assert.equal((await rolesOf(insertedId)).get(String(x)), 'moderator');
  // The raw entry is a subdocument now, not a mangled null-user row.
  const raw = await Room.findById(insertedId).lean();
  const entry = raw.members.find((m) => String(m.user || m) === String(x));
  assert.equal(String(entry.user), String(x));
  assert.equal(entry.role, 'moderator');
});

test('transferOwnership moves createdBy and both roles in one update', async (t) => {
  if (skipIfNoMongo(t)) return;
  const owner = oid(), x = oid(), y = oid();
  const room = await makeRoom([
    { user: owner, role: 'owner' }, { user: x, role: 'member' }, { user: y, role: 'member' }
  ]);
  const moved = await transferOwnership(Room, room._id, owner, x);
  assert.ok(moved, 'transfer wins');
  assert.equal(String(moved.createdBy), String(x));
  const roles = await rolesOf(room._id);
  assert.equal(roles.get(String(x)), 'owner');
  assert.equal(roles.get(String(owner)), 'moderator');
  assert.equal(roles.get(String(y)), 'member');
  // A concurrent transfer with the stale expectation misses.
  assert.equal(await transferOwnership(Room, room._id, owner, y), null,
    'the old owner no longer owns the room — the second transfer must miss');
});

test('concurrent add + kick both hold — neither update is lost', async (t) => {
  if (skipIfNoMongo(t)) return;
  // The audit's exact scenario: A reads [X, Y], B reads [X, Y]; A
  // adds Z, B kicks Y. With read-then-$set one effect was lost; with
  // atomic operators both hold, every time.
  for (let round = 0; round < 5; round++) {
    const owner = oid(), x = oid(), y = oid(), z = oid();
    const room = await makeRoom([
      { user: owner, role: 'owner' }, { user: x, role: 'member' }, { user: y, role: 'member' }
    ]);
    await Promise.all([
      addMember(Room, room._id, z, 'member'),
      removeMember(Room, room._id, y)
    ]);
    const ids = await memberIds(room._id);
    assert.ok(ids.includes(String(z)), `round ${round}: the join must hold`);
    assert.ok(!ids.includes(String(y)), `round ${round}: the kick must hold`);
    assert.ok(ids.includes(String(owner)) && ids.includes(String(x)), `round ${round}: bystanders untouched`);
  }
});

test('concurrent kick + promote: the kicked user stays kicked', async (t) => {
  if (skipIfNoMongo(t)) return;
  for (let round = 0; round < 5; round++) {
    const owner = oid(), x = oid();
    const room = await makeRoom([
      { user: owner, role: 'owner' }, { user: x, role: 'member' }
    ]);
    // Whichever lands second must not resurrect the member: the kick
    // removes the entry, and the promote's expected-role filter
    // misses once the entry is gone.
    await Promise.all([
      removeMember(Room, room._id, x),
      setMemberRole(Room, room._id, x, 'member', 'moderator')
    ]);
    const ids = await memberIds(room._id);
    assert.deepEqual(ids, [String(owner)], `round ${round}: kicked user must be gone, not re-added as moderator`);
  }
});

test('owner leave is conditional: a join racing the leave keeps the room owned', async (t) => {
  if (skipIfNoMongo(t)) return;
  const owner = oid(), joiner = oid();
  const room = await makeRoom([{ user: owner, role: 'owner' }]);
  // Simulate the race deterministically: the join lands first, so
  // the sole-member-only removal must not match.
  await addMember(Room, room._id, joiner, 'member');
  const removed = await removeMember(Room, room._id, owner, { soleMemberOnly: true });
  assert.equal(removed.matchedCount, 0, 'owner is no longer the sole member — removal must miss');
  assert.deepEqual((await memberIds(room._id)).sort(), [String(owner), String(joiner)].sort());
  // And with nobody joining, the sole-owner removal matches.
  const room2 = await makeRoom([{ user: owner, role: 'owner' }]);
  const removed2 = await removeMember(Room, room2._id, owner, { soleMemberOnly: true });
  assert.equal(removed2.matchedCount, 1);
  // NOTE: normalizeMembers() re-adds the creator as owner by design,
  // so assert on the RAW array: the removal really emptied it.
  const raw2 = await Room.findById(room2._id).lean();
  assert.deepEqual(raw2.members, []);
});
