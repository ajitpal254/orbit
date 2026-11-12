// Tests for the night-sky home helpers in frontend/src/nightSky.js:
// deterministic star positions, presence → star-state mapping, labels,
// out-count and the visible-stars cap. Pure + browser-free (ESM, like
// tests/orbLayout.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCssBundle } from './cssBundle.js';
import {
  starPosition, starState, starStatusText, starLabel, canJoin,
  outCount, visibleStars, MAX_STARS,
  ambientStars, ambientStarClass, AMBIENT_STAR_COUNT, AMBIENT_SEED
} from '../frontend/src/nightSky.js';

const friend = (id, status, room) => ({
  id, name: id, status, room: room || null
});

test('starPosition: same id always lands on the same spot', () => {
  const a = starPosition(friend('u1', 'online'), 0);
  const b = starPosition(friend('u1', 'online'), 0);
  assert.deepEqual(a, b);
});

test('starPosition: different ids scatter, and every star stays in the sky box', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const p = starPosition(friend(`user-${i}`, 'online'), i);
    assert.ok(p.x >= 8 && p.x <= 92, `x ${p.x} out of bounds`);
    assert.ok(p.y >= 14 && p.y <= 86, `y ${p.y} out of bounds`);
    assert.ok(p.size >= 26 && p.size <= 43, `size ${p.size} out of range`);
    assert.ok(p.duration >= 2.4 && p.duration <= 5.3, `duration ${p.duration} out of range`);
    seen.add(`${p.x},${p.y}`);
  }
  assert.ok(seen.size > 30, 'positions should mostly differ');
});

test('starState: in-room needs a room to join, otherwise it is plain online', () => {
  assert.equal(starState(friend('u1', 'in-room', { id: 'r1', name: 'Late Night' })), 'in-room');
  assert.equal(starState(friend('u2', 'in-room', null)), 'online');
  assert.equal(starState(friend('u3', 'in-room')), 'online');
  assert.equal(starState(friend('u4', 'online')), 'online');
  assert.equal(starState(friend('u5', 'away')), 'away');
});

test('starState: unknown or missing status is offline — never imply live', () => {
  assert.equal(starState(friend('u1', 'offline')), 'offline');
  assert.equal(starState(friend('u2', 'invisible')), 'offline');
  assert.equal(starState(friend('u3', undefined)), 'offline');
  assert.equal(starState({ id: 'u4', name: 'No status' }), 'offline');
  assert.equal(starState(null), 'offline');
  assert.equal(starState(undefined), 'offline');
});

test('canJoin: only an in-room friend with a room id', () => {
  assert.equal(canJoin(friend('u1', 'in-room', { id: 'r1' })), true);
  assert.equal(canJoin(friend('u2', 'in-room', null)), false);
  assert.equal(canJoin(friend('u3', 'online')), false);
  assert.equal(canJoin(null), false);
});

test('starStatusText + starLabel: in-room names the room, offline says so', () => {
  const live = friend('u1', 'in-room', { id: 'r1', name: 'Late Night' });
  live.name = 'Sam';
  assert.equal(starStatusText(live), 'In Late Night');
  assert.match(starLabel(live), /Sam — in Late Night\. Tap to join\./);
  const off = friend('u2', 'away');
  off.name = 'Jess';
  assert.equal(starStatusText(off), 'Away');
  assert.match(starLabel(off), /Jess — away\. Tap for details\./);
  assert.equal(starStatusText(friend('u3', 'offline')), 'Offline');
  assert.equal(starStatusText(null), 'Offline');
});

test('outCount: in-room + online count as out; away/offline do not', () => {
  const friends = [
    friend('a', 'in-room', { id: 'r1' }),
    friend('b', 'online'),
    friend('c', 'away'),
    friend('d', 'offline'),
    friend('e', 'in-room', null) // stale in-room row counts as online
  ];
  assert.equal(outCount(friends), 3);
  assert.equal(outCount([]), 0);
  assert.equal(outCount(null), 0);
});

test('visibleStars: in-room first, then online, away, offline; capped at MAX_STARS', () => {
  const friends = [
    friend('z-off', 'offline'),
    friend('a-away', 'away'),
    friend('m-on', 'online'),
    friend('b-live', 'in-room', { id: 'r1' })
  ];
  const { stars, overflow } = visibleStars(friends);
  assert.deepEqual(stars.map((f) => f.id), ['b-live', 'm-on', 'a-away', 'z-off']);
  assert.equal(overflow, 0);

  const crowd = Array.from({ length: MAX_STARS + 5 }, (_, i) =>
    friend(`u${String(i).padStart(2, '0')}`, 'online'));
  const capped = visibleStars(crowd);
  assert.equal(capped.stars.length, MAX_STARS);
  assert.equal(capped.overflow, 5);
  assert.equal(visibleStars([]).overflow, 0);
  assert.equal(visibleStars(null).stars.length, 0);
});

test('ambientStars: same seed → same field, across calls (never jumps on re-render)', () => {
  assert.deepEqual(ambientStars(), ambientStars());
  assert.deepEqual(ambientStars('orbit-sky'), ambientStars('orbit-sky'));
  assert.deepEqual(ambientStars('other-seed'), ambientStars('other-seed'));
  assert.equal(ambientStars().length, AMBIENT_STAR_COUNT);
  assert.equal(AMBIENT_SEED, 'orbit-sky');
});

test('ambientStars: a different seed is a different field', () => {
  const a = ambientStars('orbit-sky');
  const b = ambientStars('someone-else');
  assert.notDeepEqual(a, b);
});

test('ambientStars: every star stays in the stage, with a real size/opacity/twinkle', () => {
  const seen = new Set();
  for (const s of ambientStars()) {
    assert.ok(s.x >= 4 && s.x <= 96, `x ${s.x} out of bounds`);
    assert.ok(s.y >= 6 && s.y <= 94, `y ${s.y} out of bounds`);
    assert.ok(s.size >= 1 && s.size <= 2.5, `size ${s.size} out of range`);
    assert.ok(s.opacity >= 0.25 && s.opacity <= 0.85, `opacity ${s.opacity} out of range`);
    assert.ok(s.duration >= 3 && s.duration <= 7, `duration ${s.duration} out of range`);
    assert.ok(['far', 'mid', 'near'].includes(s.layer), `unknown layer ${s.layer}`);
    seen.add(`${s.x},${s.y}`);
  }
  assert.ok(seen.size > AMBIENT_STAR_COUNT - 5, 'ambient positions should mostly differ');
});

test('ambientStars: depth — far stars are smaller and dimmer than near stars', () => {
  const stars = ambientStars();
  const far = stars.filter((s) => s.layer === 'far');
  const mid = stars.filter((s) => s.layer === 'mid');
  const near = stars.filter((s) => s.layer === 'near');
  assert.ok(far.length > 0 && mid.length > 0 && near.length > 0, 'all three depth layers should appear');
  for (const s of far) {
    assert.ok(s.size <= 1.5, `far star size ${s.size} too big`);
    assert.ok(s.opacity <= 0.45, `far star opacity ${s.opacity} too bright`);
  }
  for (const s of near) {
    assert.ok(s.size >= 2, `near star size ${s.size} too small`);
    assert.ok(s.opacity >= 0.55, `near star opacity ${s.opacity} too dim`);
  }
  const avg = (arr, key) => arr.reduce((sum, s) => sum + s[key], 0) / arr.length;
  assert.ok(avg(far, 'size') < avg(mid, 'size') && avg(mid, 'size') < avg(near, 'size'), 'size should grow with depth');
  assert.ok(avg(far, 'opacity') < avg(mid, 'opacity') && avg(mid, 'opacity') < avg(near, 'opacity'), 'opacity should grow with depth');
});

test('ambientStars: count is honoured, and 0 gives an empty field', () => {
  assert.equal(ambientStars('orbit-sky', 10).length, 10);
  assert.equal(ambientStars('orbit-sky', 0).length, 0);
  assert.deepEqual(ambientStars('orbit-sky', 10).slice(0, 5), ambientStars('orbit-sky', 5));
});

test('ambientStarClass: layer picks the class, missing layer falls back to mid', () => {
  assert.equal(ambientStarClass({ layer: 'far' }), 'ambient-star ambient-star--far');
  assert.equal(ambientStarClass({ layer: 'mid' }), 'ambient-star ambient-star--mid');
  assert.equal(ambientStarClass({ layer: 'near' }), 'ambient-star ambient-star--near');
  assert.equal(ambientStarClass({}), 'ambient-star ambient-star--mid');
  assert.equal(ambientStarClass(null), 'ambient-star ambient-star--mid');
});

test('reduced motion: the ambient twinkle is stilled, and the star keeps its own brightness', () => {
  const css = readCssBundle();
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('.ambient-star'), 'reduced-motion block must mention .ambient-star');
  assert.match(reduced, /\.ambient-star\s*\{\s*animation:\s*none;\s*\}/, 'reduced motion must disable the ambient-star animation');
  // With the animation off, the star falls back to its base opacity
  // (--ao), so it sits still at its own brightness instead of going
  // invisible or full-bright.
  assert.match(css, /\.ambient-star\s*\{[^}]*opacity:\s*var\(--ao/, '.ambient-star base opacity must be its own --ao');
});
