// Tests for the pure orb-layout helper (ESM — run via node --test *.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orbPositions, initials, orbHue } from '../frontend/src/orbLayout.js';

test('orbPositions: single person sits in the middle', () => {
  const [p] = orbPositions([{ id: 'u1' }]);
  assert.equal(p.x, 50);
  assert.equal(p.y, 46);
  assert.ok(p.size >= 100);
});

test('orbPositions: everyone stays inside the room bounds', () => {
  const people = Array.from({ length: 12 }, (_, i) => ({ id: `user-${i}` }));
  for (const p of orbPositions(people)) {
    assert.ok(p.x >= 12 && p.x <= 88, `x ${p.x} out of bounds`);
    assert.ok(p.y >= 14 && p.y <= 84, `y ${p.y} out of bounds`);
    assert.ok(p.size >= 76 && p.size <= 112);
    assert.ok(p.duration >= 6 && p.duration <= 10);
  }
});

test('orbPositions: deterministic — same people, same layout', () => {
  const people = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(orbPositions(people), orbPositions(people));
});

test('orbPositions: no two orbs share the same spot', () => {
  const people = Array.from({ length: 6 }, (_, i) => ({ id: `peer-${i}` }));
  const spots = orbPositions(people).map((p) => `${p.x},${p.y}`);
  assert.equal(new Set(spots).size, spots.length);
});

test('initials and orbHue behave', () => {
  assert.equal(initials('Ajit Pal'), 'AP');
  assert.equal(initials('riya'), 'RI');
  assert.equal(orbHue('ajit'), orbHue('ajit'));
  assert.ok(orbHue('ajit') >= 0 && orbHue('ajit') < 360);
});
