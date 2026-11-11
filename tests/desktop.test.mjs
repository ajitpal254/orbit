// Tests for the desktop 3-zone hero picker in frontend/src/desktop.js:
// the busiest live room wins, and its occupants shape up for the orb
// renderer. Pure + browser-free (ESM, like tests/orbLayout.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBusiestRoom, heroOccupants } from '../frontend/src/desktop.js';

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
