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

test('orbPositions: room-view people use socketId, not id', () => {
  // Regression: the room view passes occupants shaped like
  // { socketId, userId, name } with no `id` field. Positions must be
  // keyed by socketId, or the orbs never render (posById lookup misses).
  const people = [
    { socketId: 'sock-aaa', userId: 'u1', name: 'Ajit Pal' },
    { socketId: 'sock-zzz', userId: 'u2', name: 'Riya' },
    { socketId: 'self', userId: 'u3', name: 'Test' }
  ];
  const positions = orbPositions(people);
  assert.deepEqual(positions.map((p) => p.id), ['sock-aaa', 'sock-zzz', 'self']);
  for (const p of positions) {
    assert.ok(p.x >= 12 && p.x <= 88, `x ${p.x} out of bounds`);
    assert.ok(p.y >= 14 && p.y <= 84, `y ${p.y} out of bounds`);
  }
  const [solo] = orbPositions([{ socketId: 'only-one', userId: 'u9', name: 'Solo' }]);
  assert.equal(solo.id, 'only-one');
  assert.equal(solo.x, 50);
});

test('initials and orbHue behave', () => {
  assert.equal(initials('Ajit Pal'), 'AP');
  assert.equal(initials('riya'), 'RI');
  assert.equal(orbHue('ajit'), orbHue('ajit'));
  assert.ok(orbHue('ajit') >= 0 && orbHue('ajit') < 360);
});

test('orbPositions: with a container, no orb clips at any edge on a phone', () => {
  // Regression: on a ~390px phone the blue orb was half cut off at the
  // left edge — the old %-only clamp (x >= 12%) ignored the orb radius
  // in px, so a 112px orb centered at 12% of a 360px room stuck 13px
  // past the edge. With a container, center ± radius must stay inside.
  const inBounds = (p, w, h) => {
    const r = p.size / 2;
    const cx = (p.x / 100) * w;
    const cy = (p.y / 100) * h;
    assert.ok(cx - r >= 0, `orb ${p.id} clips left at ${w}x${h} (x=${p.x}, size=${p.size})`);
    assert.ok(cx + r <= w, `orb ${p.id} clips right at ${w}x${h}`);
    assert.ok(cy - r >= 0, `orb ${p.id} clips top at ${w}x${h}`);
    assert.ok(cy + r <= h, `orb ${p.id} clips bottom at ${w}x${h}`);
  };
  for (const [w, h] of [[360, 520], [320, 480], [390, 600], [800, 600], [280, 400]]) {
    for (let n = 1; n <= 6; n++) {
      const people = Array.from({ length: n }, (_, i) => ({ id: `u${w}-${n}-${i}` }));
      for (const p of orbPositions(people, { width: w, height: h })) inBounds(p, w, h);
    }
  }
  // Fuzz: many ids and room sizes, room-view shaped people included.
  for (let i = 0; i < 200; i++) {
    const n = 2 + (i % 5);
    const people = Array.from({ length: n }, (_, j) => ({ socketId: `sock-${i}-${j}` }));
    const w = 300 + ((i * 37) % 500);
    const h = 400 + ((i * 53) % 300);
    for (const p of orbPositions(people, { width: w, height: h })) inBounds(p, w, h);
  }
});

test('orbPositions: deterministic with a container, and solo stays centered', () => {
  const people = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const c = { width: 360, height: 520 };
  assert.deepEqual(orbPositions(people, c), orbPositions(people, c));
  const [solo] = orbPositions([{ id: 'only' }], c);
  assert.equal(solo.x, 50);
  assert.equal(solo.y, 46);
});

test('orbPositions: desktop rooms stay inside bounds and orbs scale up', () => {
  // Desktop layout: the orb area is much bigger than a phone room, so
  // orbs must still clamp inside it (center ± radius) — and they grow
  // with the room instead of looking lost in it.
  const inBounds = (p, w, h) => {
    const r = p.size / 2;
    const cx = (p.x / 100) * w;
    const cy = (p.y / 100) * h;
    assert.ok(cx - r >= 0, `orb ${p.id} clips left at ${w}x${h}`);
    assert.ok(cx + r <= w, `orb ${p.id} clips right at ${w}x${h}`);
    assert.ok(cy - r >= 0, `orb ${p.id} clips top at ${w}x${h}`);
    assert.ok(cy + r <= h, `orb ${p.id} clips bottom at ${w}x${h}`);
  };
  for (const [w, h] of [[1200, 800], [1000, 650], [1400, 900], [900, 600]]) {
    for (let n = 1; n <= 6; n++) {
      const people = Array.from({ length: n }, (_, i) => ({ id: `d${w}-${n}-${i}` }));
      for (const p of orbPositions(people, { width: w, height: h })) inBounds(p, w, h);
    }
  }
  // Sizes grow with the room: a solo orb on a 1200×800 desktop room is
  // bigger than the 118px phone solo orb, and multi-person orbs exceed
  // the 76–112px phone range.
  const [solo] = orbPositions([{ id: 'solo-d' }], { width: 1200, height: 800 });
  assert.ok(solo.size > 118, `solo desktop orb ${solo.size} should be bigger than phone 118`);
  const multi = orbPositions(
    Array.from({ length: 4 }, (_, i) => ({ id: `dm${i}` })),
    { width: 1200, height: 800 }
  );
  assert.ok(multi.every((p) => p.size > 76), 'desktop orbs should all be bigger than the smallest phone orb');
  assert.ok(multi.some((p) => p.size > 112), 'desktop orbs should exceed the phone size range');
  // Phones keep scale 1: the same people in a 360×520 room stay at
  // phone sizes.
  const [soloPhone] = orbPositions([{ id: 'solo-p' }], { width: 360, height: 520 });
  assert.equal(soloPhone.size, 118);
});

test('orbPositions: desktop layout is deterministic', () => {
  const people = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const c = { width: 1200, height: 800 };
  assert.deepEqual(orbPositions(people, c), orbPositions(people, c));
});
