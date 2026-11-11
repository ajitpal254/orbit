// Tests for the v0.3.0 mobile basics (M1–M3): the ≤520px layout rules
// in frontend/src/index.css and the small pure helpers in
// frontend/src/desktop.js / mobileNav.js. No React, no DOM — the CSS
// is asserted by extracting the media block, the same file-reading
// approach as tests/visualSystem.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../frontend/src/index.css', import.meta.url), 'utf8');
const roomViewJsx = readFileSync(new URL('../frontend/src/components/RoomView.jsx', import.meta.url), 'utf8');

// The one `@media (max-width: 520px)` block: every phone rule must
// live inside it, so desktop (and the 521–899px tablet range) is
// untouched. Brace-matched extraction, not a regex — the block holds
// nested rules.
export function phoneBlock(source) {
  const start = source.indexOf('@media (max-width: 520px)');
  assert.notEqual(start, -1, 'no max-width: 520px block in index.css');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unterminated max-width: 520px block');
}

const phone = phoneBlock(css);
// Everything outside the phone block (desktop + tablet + base) must
// not carry phone-only rules — the collapse, tab bar and stories row
// are display:none / inert there.
const outsidePhone = css.replace('@media (max-width: 520px) {' + phone + '}', '');

test('phone block: there is exactly one max-width: 520px block', () => {
  const count = (css.match(/@media \(max-width: 520px\)/g) || []).length;
  assert.equal(count, 1);
});

// --- M1: collapsible members panel ---------------------------------------
test('M1: the phone block collapses the members panel until it is opened', () => {
  for (const sel of [
    '.members-panel:not(.members-panel--open) .members-list',
    '.members-panel:not(.members-panel--open) .members-note',
    '.members-panel:not(.members-panel--open) .invite-picker',
    '.members-panel:not(.members-panel--open) .members-head > span'
  ]) {
    assert.ok(phone.includes(sel), `phone block is missing ${sel}`);
  }
  // The hidden parts share one display:none declaration.
  assert.match(phone, /\.members-panel:not\(\.members-panel--open\)[^{]*\{[^}]*display: none/);
});

test('M1: the toggle chevron only shows on phones (desktop keeps the static title)', () => {
  assert.ok(phone.includes('.members-toggle .members-toggle-chev'), 'phone block must show the toggle chevron');
  assert.ok(phone.includes('.members-panel--open .members-toggle .members-toggle-chev'), 'open state must rotate the chevron');
  assert.match(
    outsidePhone,
    /\.members-toggle \.members-toggle-chev \{ display: none; \}/,
    'outside the phone block the chevron must be hidden'
  );
});

test('M1: RoomView wires the toggle to the panel class and aria state', () => {
  assert.match(roomViewJsx, /const \[membersOpen, setMembersOpen\] = useState\(false\)/);
  assert.ok(roomViewJsx.includes("members-panel card${membersOpen ? ' members-panel--open' : ''}"));
  assert.ok(roomViewJsx.includes('className="members-toggle"'));
  assert.ok(roomViewJsx.includes('aria-expanded={membersOpen}'));
  assert.ok(roomViewJsx.includes('aria-controls="members-list"'));
  // Invite / Leave stay inside the panel header (reachable on expand).
  assert.ok(roomViewJsx.includes('Invite a friend'));
  assert.ok(roomViewJsx.includes('Leave room'));
});
