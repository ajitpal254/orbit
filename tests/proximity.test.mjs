// Tests for the proximity-audio pure logic (frontend/src/proximity.js):
// the distance -> volume curve (incl. the 0.15 floor and the audible
// radius), gain hysteresis, position clamping, and huddle clustering
// (thresholds, singletons, chains, hysteresis).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPATIAL_AUDIO_ENABLED,
  FULL_GAIN_RADIUS,
  AUDIBLE_RADIUS,
  MIN_GAIN,
  HUDDLE_THRESHOLD,
  gainForDistance,
  distanceBetween,
  clampPosition,
  clusterHuddles
} from '../frontend/src/proximity.js';

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('curve constants: the documented shape', () => {
  assert.equal(SPATIAL_AUDIO_ENABLED, true, 'kill switch ships on');
  assert.equal(FULL_GAIN_RADIUS, 25);
  assert.equal(AUDIBLE_RADIUS, 90);
  assert.equal(MIN_GAIN, 0.15);
  assert.equal(HUDDLE_THRESHOLD, 30);
});

test('gainForDistance: full volume up close, floor far away', () => {
  assert.equal(gainForDistance(0), 1);
  assert.equal(gainForDistance(10), 1);
  assert.equal(gainForDistance(FULL_GAIN_RADIUS), 1);
  // Mid-falloff: d=50 -> 1 - (25/65) * 0.85
  assert.ok(approx(gainForDistance(50), 1 - (25 / 65) * 0.85));
  // d=70 -> 1 - (45/65) * 0.85
  assert.ok(approx(gainForDistance(70), 1 - (45 / 65) * 0.85));
  // At the audible radius the floor is reached, and it holds beyond it.
  assert.equal(gainForDistance(AUDIBLE_RADIUS), MIN_GAIN);
  assert.equal(gainForDistance(120), MIN_GAIN);
  assert.equal(gainForDistance(500), MIN_GAIN);
  // Negative distance is nonsense input — treat as "on top of me".
  assert.equal(gainForDistance(-5), 1);
});

test('gainForDistance: the 0.15 floor is deliberate, never silence', () => {
  for (const d of [90, 100, 141, 1000]) {
    assert.ok(gainForDistance(d) > 0, `d=${d} stays audible`);
    assert.equal(gainForDistance(d), MIN_GAIN);
  }
});

test('gainForDistance: non-finite distance means no position — full gain', () => {
  assert.equal(gainForDistance(NaN), 1);
  assert.equal(gainForDistance(Infinity), 1);
  assert.equal(gainForDistance(undefined), 1);
  assert.equal(gainForDistance(null), 1);
});

test('gainForDistance: hysteresis swallows small changes, applies big ones', () => {
  const close = gainForDistance(50); // ~0.673
  // d=52 recomputes to ~0.647 — within 0.05 of the current gain, so
  // the volume must not flicker on a 2% orb wobble.
  assert.equal(gainForDistance(52, close), close);
  // d=70 recomputes to ~0.412 — a real move, so the gain must follow.
  const far = gainForDistance(70, close);
  assert.ok(approx(far, 1 - (45 / 65) * 0.85));
  assert.notEqual(far, close);
  // Without a previous gain there is nothing to hold onto.
  assert.ok(approx(gainForDistance(52), 1 - (27 / 65) * 0.85));
});

test('gainForDistance: gain decreases monotonically with distance', () => {
  let prev = 2;
  for (let d = 0; d <= 120; d += 5) {
    const g = gainForDistance(d);
    assert.ok(g <= prev, `gain at d=${d} (${g}) must not exceed gain at d=${d - 5}`);
    prev = g;
  }
});

test('distanceBetween: Euclidean in % units', () => {
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(distanceBetween({ x: 50, y: 50 }, { x: 50, y: 50 }), 0);
});

test('clampPosition: inside the room, out-of-range clamped, garbage centred', () => {
  assert.deepEqual(clampPosition(50, 50), { x: 50, y: 50 });
  assert.deepEqual(clampPosition(150, -20), { x: 100, y: 0 });
  assert.deepEqual(clampPosition(-5, 101), { x: 0, y: 100 });
  assert.deepEqual(clampPosition(NaN, 50), { x: 50, y: 50 });
  assert.deepEqual(clampPosition(50, Infinity), { x: 50, y: 50 });
});

test('clusterHuddles: two close orbs form one huddle', () => {
  const h = clusterHuddles([
    { id: 'a', x: 40, y: 40 },
    { id: 'b', x: 50, y: 40 }
  ]);
  assert.equal(h.length, 1);
  assert.deepEqual([...h[0].ids].sort(), ['a', 'b']);
  assert.equal(h[0].cx, 45);
  assert.equal(h[0].cy, 40);
  // Radius: farthest member from the centroid (5) + the 16 orb margin.
  assert.equal(h[0].radius, 21);
});

test('clusterHuddles: far apart orbs do not cluster; singletons dropped', () => {
  assert.deepEqual(clusterHuddles([
    { id: 'a', x: 10, y: 10 },
    { id: 'b', x: 90, y: 90 }
  ]), []);
  // Two close + one far: one huddle of two, the loner is not a huddle.
  const h = clusterHuddles([
    { id: 'a', x: 40, y: 40 },
    { id: 'b', x: 45, y: 40 },
    { id: 'c', x: 90, y: 90 }
  ]);
  assert.equal(h.length, 1);
  assert.deepEqual([...h[0].ids].sort(), ['a', 'b']);
  assert.deepEqual(clusterHuddles([{ id: 'a', x: 50, y: 50 }]), []);
  assert.deepEqual(clusterHuddles([]), []);
});

test('clusterHuddles: threshold boundary is strict', () => {
  // Exactly at the threshold does not cluster (d < threshold).
  assert.deepEqual(clusterHuddles([
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: HUDDLE_THRESHOLD, y: 0 }
  ]), []);
  // Just inside it does.
  assert.equal(clusterHuddles([
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: HUDDLE_THRESHOLD - 0.1, y: 0 }
  ]).length, 1);
});

test('clusterHuddles: a chain clusters even when the ends are far apart', () => {
  const h = clusterHuddles([
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 20, y: 0 },
    { id: 'c', x: 40, y: 0 }
  ]);
  assert.equal(h.length, 1);
  assert.deepEqual([...h[0].ids].sort(), ['a', 'b', 'c']);
});

test('clusterHuddles: two separate clusters stay separate', () => {
  const h = clusterHuddles([
    { id: 'a', x: 10, y: 10 },
    { id: 'b', x: 15, y: 10 },
    { id: 'c', x: 80, y: 80 },
    { id: 'd', x: 85, y: 80 }
  ]);
  assert.equal(h.length, 2);
  assert.deepEqual(h.map((x) => [...x.ids].sort()), [['a', 'b'], ['c', 'd']]);
});

test('clusterHuddles: hysteresis keeps a huddle together past the threshold', () => {
  const prev = clusterHuddles([
    { id: 'a', x: 40, y: 40 },
    { id: 'b', x: 50, y: 40 }
  ]);
  assert.equal(prev.length, 1);
  // 32 apart is past the 30 threshold, but inside 30 + 5 hysteresis —
  // the bubble must not pop while the orbs hover near the boundary.
  const held = clusterHuddles([
    { id: 'a', x: 40, y: 40 },
    { id: 'b', x: 72, y: 40 }
  ], prev);
  assert.equal(held.length, 1);
  // 36 apart is past threshold + hysteresis: the huddle breaks.
  assert.deepEqual(clusterHuddles([
    { id: 'a', x: 40, y: 40 },
    { id: 'b', x: 76, y: 40 }
  ], prev), []);
  // And without a previous huddle, 32 apart never forms one.
  assert.deepEqual(clusterHuddles([
    { id: 'a', x: 40, y: 40 },
    { id: 'b', x: 72, y: 40 }
  ]), []);
});

test('clusterHuddles: points with missing coordinates are ignored', () => {
  const h = clusterHuddles([
    { id: 'a', x: 40, y: 40 },
    { id: 'b', x: 45, y: 40 },
    { id: 'ghost', x: NaN, y: 40 },
    { id: 'ghost2' }
  ]);
  assert.equal(h.length, 1);
  assert.deepEqual([...h[0].ids].sort(), ['a', 'b']);
});
