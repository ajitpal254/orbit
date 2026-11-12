// Tests for the v0.8.0 desktop polish (Desktop Feature Plan v2 §2):
// the sky flex-fills the centre column, a dashed "+ New room" card
// closes the rooms grid, and the right panel stretches with a dim
// "Quiet tonight" line. CSS is asserted against the bundle the way
// the browser gets it (see tests/cssBundle.js); the JSX wiring is
// asserted from source. No React, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCssBundle } from './cssBundle.js';

const css = readCssBundle();
const homeJsx = readFileSync(new URL('../frontend/src/components/Home.jsx', import.meta.url), 'utf8');
const sidePanelJsx = readFileSync(new URL('../frontend/src/components/SidePanel.jsx', import.meta.url), 'utf8');

// The `@media (min-width: 900px)` blocks (desktop.css holds the main
// one; room.css holds a small one for the shortcuts hint): every
// desktop rule must live inside one of them, so the phone layout
// (≤520px) is untouched. Brace-matched extraction, not a regex — the
// blocks hold nested rules (@keyframes ambient-drift).
function desktopBlocks(source) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('@media (min-width: 900px)', from);
    if (start === -1) break;
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
    if (end === -1) throw new Error('unterminated min-width: 900px block');
    blocks.push(source.slice(open + 1, end));
    from = end + 1;
  }
  assert.ok(blocks.length > 0, 'no min-width: 900px block in the CSS bundle');
  return blocks.join('\n');
}

const desktop = desktopBlocks(css);

test('desktop blocks: the main desktop block lives in desktop.css', () => {
  const count = (css.match(/@media \(min-width: 900px\)/g) || []).length;
  assert.equal(count, 2, 'expected the desktop.css block plus the small room.css shortcuts block');
});

// --- Fix ①: sky flex-fills the centre column --------------------------
test('sky: .night-sky flex-fills with min-height 220px, stage fills it', () => {
  assert.match(desktop, /\.night-sky\s*\{[^}]*flex:\s*1/, '.night-sky must flex-fill (flex: 1)');
  assert.match(desktop, /\.night-sky\s*\{[^}]*min-height:\s*220px/, '.night-sky must have min-height: 220px');
  assert.match(desktop, /\.night-sky-stage\s*\{[^}]*flex:\s*1/, '.night-sky-stage must flex-fill the section');
  assert.match(desktop, /\.night-sky-stage\s*\{[^}]*min-height:\s*220px/, '.night-sky-stage must have min-height: 220px');
});

test('sky: the fixed 216px desktop stage height is gone, phone 168px kept', () => {
  assert.ok(!desktop.includes('height: 216px'), 'desktop block must not keep the fixed 216px stage height');
  assert.ok(css.includes('.night-sky-stage { position: relative; height: 168px; }'), 'phone stage stays at the fixed 168px from home.css');
});

test('sky: has-hero still hides the sky (rule order matters)', () => {
  // Same specificity as .night-sky, so display:none only wins if it
  // comes later in the cascade. Match the rule declarations (with the
  // opening brace), not mentions inside comments.
  const skyAt = desktop.search(/\.night-sky\s*\{/);
  const heroAt = desktop.search(/\.night-sky--has-hero\s*\{/);
  assert.ok(skyAt !== -1 && heroAt !== -1, 'both .night-sky and .night-sky--has-hero rules must be in the desktop block');
  assert.ok(heroAt > skyAt, '.night-sky--has-hero must come after .night-sky so its display:none wins');
  assert.match(desktop, /\.night-sky--has-hero\s*\{\s*display:\s*none/, 'has-hero must still hide the sky');
});

// --- Fix ②: dashed "+ New room" card ----------------------------------
test('new-room card: dashed border + dim opacity in the desktop block', () => {
  assert.match(desktop, /\.room-card--new\s*\{[^}]*border:\s*1px dashed rgba\(255,\s*255,\s*255,\s*0\.25\)/, 'card must have the dashed border');
  assert.match(desktop, /\.room-card--new\s*\{[^}]*opacity:\s*0\.45/, 'card must be dim at opacity 0.45');
});

test('new-room card: hidden below 900px so phones keep their list', () => {
  assert.ok(css.includes('.room-card--new { display: none; }'), 'base CSS must hide the card outside the desktop block');
});

test('new-room card: rendered after the real cards, opens the existing create form', () => {
  assert.ok(homeJsx.includes('room-card--new'), 'Home.jsx must render the dashed card');
  assert.ok(homeJsx.includes('<NewRoomCard onOpen={openCreate}'), 'card must wire to openCreate');
  assert.ok(homeJsx.includes('const openCreate = () => setShowCreate(true);'), 'openCreate must open the existing create-room form, not a new flow');
  assert.ok(homeJsx.includes('+ New room'), 'card must read "+ New room"');
});

test('new-room card: accessible name must not collide with the header button', () => {
  // The smoke test selects the header button with
  // getByRole('button', { name: 'New room' }); Playwright matches
  // names by substring, so a second button whose accessible name
  // contains "New room" would fail strict mode.
  const label = homeJsx.match(/aria-label="([^"]*)"/g) || [];
  const cardLabel = (homeJsx.match(/className="room-card room-card--new[^"]*"[\s\S]{0,400}?aria-label="([^"]*)"/) || [])[1];
  assert.ok(cardLabel, 'card must carry an explicit aria-label');
  assert.ok(!/new room/i.test(cardLabel), `card aria-label (${cardLabel}) must not contain "New room"`);
  assert.ok(label.length > 0, 'expected aria-labels in Home.jsx');
});

// --- Fix ③: right panel stretches + "Quiet tonight" --------------------
test('right panel: .home-side stretches with min-height 100%', () => {
  assert.match(desktop, /\.home-side\s*\{[^}]*min-height:\s*100%/, '.home-side must have min-height: 100%');
});

test('right panel: dim "Quiet tonight" line when activity is empty or a single item', () => {
  assert.ok(sidePanelJsx.includes('Quiet tonight'), 'SidePanel.jsx must render the "Quiet tonight" line');
  assert.ok(sidePanelJsx.includes('groupedActivity.length < 2'), 'line must show when the grouped activity list is empty or has one item');
  assert.match(desktop, /\.side-quiet\s*\{[^}]*opacity:\s*0\.7/, '.side-quiet must be dim');
});

// --- Fix ④: ambient inset is already applied — do not touch ------------
test('ambient: the -3% inset stays applied', () => {
  assert.ok(desktop.includes('inset: -3%'), 'ambient body::before must keep inset: -3%');
});
