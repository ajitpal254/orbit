// Tests for the desktop 3-zone hero picker in frontend/src/desktop.js:
// the busiest live room wins, and its occupants shape up for the orb
// renderer. Pure + browser-free (ESM, like tests/orbLayout.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBusiestRoom, heroOccupants, groupActivity } from '../frontend/src/desktop.js';

const room = (id, occupants) => ({
  id,
  name: id,
  occupantCount: occupants.length,
  occupants
});
const occ = (userId, speaking = false) => ({ userId, name: userId, speaking });

test('selectBusiestRoom: the room with the most occupants wins', () => {
  const a = room('a', [occ('u1')]);
  const b = room('b', [occ('u1'), occ('u2'), occ('u3')]);
  const c = room('c', [occ('u1'), occ('u2')]);
  assert.equal(selectBusiestRoom([a, b, c]), b);
  assert.equal(selectBusiestRoom([c, a, b]), b);
});

test('selectBusiestRoom: ties break toward the room with more speakers', () => {
  const quiet = room('quiet', [occ('u1'), occ('u2')]);
  const talking = room('talking', [occ('u3', true), occ('u4')]);
  assert.equal(selectBusiestRoom([quiet, talking]), talking);
  assert.equal(selectBusiestRoom([talking, quiet]), talking);
});

test('selectBusiestRoom: empty rooms never win; null when nobody is live', () => {
  const empty = room('empty', []);
  const live = room('live', [occ('u1')]);
  assert.equal(selectBusiestRoom([empty, live]), live);
  assert.equal(selectBusiestRoom([empty]), null);
  assert.equal(selectBusiestRoom([]), null);
  assert.equal(selectBusiestRoom(null), null);
});

test('selectBusiestRoom: a room missing occupantCount is treated as empty', () => {
  assert.equal(selectBusiestRoom([{ id: 'x', name: 'x' }]), null);
});

test('heroOccupants: REST occupants become orb people keyed by user id', () => {
  const r = room('r', [occ('u1', true), occ('u2')]);
  assert.deepEqual(heroOccupants(r), [
    { socketId: 'u1', userId: 'u1', name: 'u1', speaking: true },
    { socketId: 'u2', userId: 'u2', name: 'u2', speaking: false }
  ]);
  assert.deepEqual(heroOccupants(null), []);
  assert.deepEqual(heroOccupants({}), []);
});

// groupActivity: consecutive same-type/same-actor rows merge into one.
const notif = (id, type, actorId, actorName, createdAt, read = false) => ({
  id,
  type,
  actor: actorId ? { id: actorId, name: actorName } : null,
  text: type === 'dm' ? `New message from ${actorName}` : `${actorName} did a ${type}`,
  createdAt,
  updatedAt: createdAt,
  read
});

test('groupActivity: three DMs from one person become one row with a count', () => {
  const groups = groupActivity([
    notif('n1', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:00:00Z'),
    notif('n2', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:01:00Z'),
    notif('n3', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:02:00Z')
  ]);
  assert.equal(groups.length, 1);
  const [g] = groups;
  assert.equal(g.type, 'dm');
  assert.equal(g.count, 3);
  assert.equal(g.text, '3 new messages from Ajit Pal');
  assert.equal(g.newest.id, 'n3');
  assert.equal(g.latestAt, '2026-11-11T14:02:00Z');
  assert.equal(g.items.length, 3);
  assert.equal(g.unread, true);
});

test('groupActivity: different actors and types stay separate', () => {
  const groups = groupActivity([
    notif('n1', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:00:00Z'),
    notif('n2', 'dm', 'a2', 'TestMuse', '2026-11-11T14:01:00Z'),
    notif('n3', 'room_invite', 'a1', 'Ajit Pal', '2026-11-11T14:02:00Z'),
    notif('n4', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:03:00Z')
  ]);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map((g) => g.count), [1, 1, 1, 1]);
});

test('groupActivity: non-consecutive repeats do not merge', () => {
  const groups = groupActivity([
    notif('n1', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:00:00Z'),
    notif('n2', 'friend_request', 'a2', 'TestMuse', '2026-11-11T14:01:00Z'),
    notif('n3', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:02:00Z')
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].count, 1);
  assert.equal(groups[2].count, 1);
});

test('groupActivity: a single item passes through with its original text', () => {
  const [g] = groupActivity([notif('n1', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:00:00Z')]);
  assert.equal(g.count, 1);
  assert.equal(g.text, 'New message from Ajit Pal');
  assert.equal(g.newest.id, 'n1');
  assert.equal(g.unread, true);
});

test('groupActivity: unread is true if any item in the group is unread', () => {
  const [allRead] = groupActivity([
    notif('n1', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:00:00Z', true),
    notif('n2', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:01:00Z', true)
  ]);
  assert.equal(allRead.unread, false);
  const [mixed] = groupActivity([
    notif('n1', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:00:00Z', true),
    notif('n2', 'dm', 'a1', 'Ajit Pal', '2026-11-11T14:01:00Z', false)
  ]);
  assert.equal(mixed.unread, true);
});

test('groupActivity: empty and null input give no groups', () => {
  assert.deepEqual(groupActivity([]), []);
  assert.deepEqual(groupActivity(null), []);
  assert.deepEqual(groupActivity(undefined), []);
});
