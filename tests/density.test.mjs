// Tests for the v0.9.0 desktop density (bento layout, constellation
// + streak strips, "Recently quiet" split, ambient canvas). CSS is
// asserted against the bundle the way the browser gets it (see
// tests/cssBundle.js); the JSX wiring is asserted from source. No
// React, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCssBundle } from './cssBundle.js';

const css = readCssBundle();
const homeJsx = readFileSync(new URL('../frontend/src/components/Home.jsx', import.meta.url), 'utf8');
const constellationJsx = readFileSync(new URL('../frontend/src/components/ConstellationStrip.jsx', import.meta.url), 'utf8');
const streakJsx = readFileSync(new URL('../frontend/src/components/StreakStrip.jsx', import.meta.url), 'utf8');
const desktopCss = readFileSync(new URL('../frontend/src/css/desktop.css', import.meta.url), 'utf8');

// Brace-matched extraction of the `@media (min-width: 1280px)` block
// (same approach as desktopPolish.test.mjs for the 900px blocks).
function block1280(source) {
  const start = source.indexOf('@media (min-width: 1280px)');
  assert.ok(start !== -1, 'no min-width: 1280px block in the CSS bundle');
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end !== -1, 'unterminated min-width: 1280px block');
  return source.slice(open + 1, end);
}

const bento = block1280(css);

test('bento: exactly one 1280px block, and the 900px blocks are untouched', () => {
  assert.equal((css.match(/@media \(min-width: 1280px\)/g) || []).length, 1, 'expected a single min-width: 1280px block');
  assert.equal((css.match(/@media \(min-width: 900px\)/g) || []).length, 3, 'the three 900px blocks must be unchanged');
  assert.ok(desktopCss.indexOf('@media (min-width: 1280px)') > desktopCss.indexOf('@media (min-width: 900px)'), 'the 1280px block must come after the 900px block so its overrides win');
});

test('bento: three columns — two content columns plus the 320px friends panel', () => {
  assert.match(bento, /\.home-view\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\)\s*320px/, 'home-view must be 1fr 1fr 320px at ≥1280px');
  assert.match(bento, /\.home-side\s*\{[^}]*grid-column:\s*3/, 'side panel must move to column 3');
});

test('bento: sky is the tall left block spanning two rows', () => {
  assert.match(bento, /\.home-view\s*>\s*\.night-sky\s*\{[^}]*grid-column:\s*1/, 'sky must sit in column 1');
  assert.match(bento, /\.home-view\s*>\s*\.night-sky\s*\{[^}]*grid-row:\s*span 2/, 'sky must span 2 rows');
});

test('bento: hero and streak stack in column 2; full width when the sky is hidden', () => {
  assert.match(bento, /\.home-view\s*>\s*\.hero-card,\s*\.home-view\s*>\s*\.streak-strip\s*\{[^}]*grid-column:\s*2/, 'hero + streak must sit in column 2');
  assert.match(bento, /\.home-view--has-hero\s*>\s*\.hero-card,\s*\.home-view--has-hero\s*>\s*\.streak-strip\s*\{[^}]*grid-column:\s*1\s*\/\s*span 2/, 'with a live hero (sky hidden) hero + streak must span both bento columns');
  assert.match(bento, /\.home-view\s*>\s*\*:not\(\.home-side\)\s*\{[^}]*grid-column:\s*1\s*\/\s*span 2/, 'every other child must span both bento columns');
});

test('strips: hidden below 1280px, shown as flex cards inside the bento', () => {
  assert.ok(css.includes('.constellation-strip, .streak-strip, .rooms-section--split, .recently-quiet-section { display: none; }'), 'strips + split sections must be display:none in base CSS');
  assert.match(bento, /\.constellation-strip\s*\{[^}]*display:\s*flex/, 'constellation strip must show at ≥1280px');
  assert.match(bento, /\.streak-strip\s*\{[^}]*display:\s*flex/, 'streak strip must show at ≥1280px');
});

test('constellation strip: in-room glows, online holds a ring, away is dim', () => {
  assert.match(bento, /\.constellation-orb--in-room\s+\.avatar\s*\{[^}]*box-shadow:[^}]*#34d399/, 'in-room avatar must glow green');
  assert.match(bento, /\.constellation-orb--online\s+\.avatar\s*\{[^}]*box-shadow:[^}]*#34d399/, 'online avatar must hold a green ring');
  assert.match(bento, /\.constellation-orb--away\s*\{[^}]*opacity:\s*0\.5/, 'away friend must be dim');
});

test('streak strip: active day dots are highlighted', () => {
  assert.match(bento, /\.streak-dot--active\s*\{[^}]*#fbbf24/, 'active day dot must highlight amber');
});

test('recently quiet: phone list hides, split lists show, quiet cards are dimmed', () => {
  assert.match(bento, /\.rooms-section--all\s*\{\s*display:\s*none/, 'the un-split phone list must hide at ≥1280px');
  assert.match(bento, /\.rooms-section--split,\s*\.recently-quiet-section\s*\{\s*display:\s*block/, 'the split lists must show at ≥1280px');
  assert.match(bento, /\.room-card--quiet\s*\{[^}]*opacity:\s*0\.55/, 'quiet cards must be dimmed at opacity 0.55');
});

test('ambient: the 1280px layer extends the same body::before — no new position, no bigger gradients', () => {
  const ambient = bento.match(/body::before\s*\{([\s\S]*?)\n  \}/);
  assert.ok(ambient, 'the 1280px block must extend body::before');
  assert.ok(!/position\s*:/.test(ambient[1]), 'the extension must not redeclare position (same layer as the 900px block)');
  const gradientSizes = [...ambient[1].matchAll(/radial-gradient\((\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(gradientSizes.length > 0, 'expected gradients in the extended layer');
  assert.ok(gradientSizes.every((s) => s <= 800), `no gradient larger than the existing 800px nebula, got ${gradientSizes}`);
  // Denser star field than the 900px layer (8 star points there).
  const stars = (ambient[1].match(/radial-gradient\(1px 1px/g) || []).length
    + (ambient[1].match(/radial-gradient\(1\.5px 1\.5px/g) || []).length;
  assert.ok(stars > 8, `expected a denser star field than the 900px layer, got ${stars} star points`);
});

test('Home wires both strips and the quiet split', () => {
  assert.ok(homeJsx.includes('<ConstellationStrip friends={presence}'), 'Home must render the constellation strip from the shared presence fetch');
  assert.ok(homeJsx.includes('<StreakStrip activity={activity}'), 'Home must render the streak strip from /api/me/activity');
  assert.ok(homeJsx.includes('getMyActivity'), 'Home must load the activity endpoint');
  assert.ok(homeJsx.includes('home-view--has-hero'), 'Home must mark the has-hero bento variant');
  assert.ok(homeJsx.includes('recently-quiet-section'), 'Home must render the Recently quiet section');
  assert.ok(homeJsx.includes('rooms-section--all'), 'Home must keep the un-split phone list');
  assert.ok(homeJsx.includes('rooms-section--split'), 'Home must render the desktop split list');
  assert.ok(homeJsx.includes('quietRooms(rooms)'), 'Home must split rooms with the quietRooms helper');
});

test('ConstellationStrip reuses presence data and joins in-room friends, never a new endpoint', () => {
  assert.ok(!constellationJsx.includes('getFriendsPresence'), 'the strip must not fetch presence itself — Home passes it in');
  assert.ok(!constellationJsx.includes("apiJson('/api/friends"), 'the strip must not call the presence endpoint itself');
  assert.ok(constellationJsx.includes("apiJson(`/api/rooms/${friend.room.id}`)"), 'an in-room friend must join via the existing room fetch');
  assert.ok(constellationJsx.includes("onNavigate({ view: 'friends' })"), 'other friends must open the Friends view');
  assert.ok(constellationJsx.includes('constellation-orb--${friend.status}'), 'the ring class must come from the presence status');
});

test('StreakStrip derives from weekActivity and never fakes activity', () => {
  assert.ok(streakJsx.includes('weekActivity(activity'), 'the strip must derive from the activity payload');
  assert.ok(streakJsx.includes('Quiet week so far'), 'zero active days must say the week is quiet, not show a fake streak');
  assert.ok(streakJsx.includes('Couldn'), 'a failed fetch must say the week could not load');
});
