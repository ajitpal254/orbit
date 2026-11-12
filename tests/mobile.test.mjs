// Tests for the v0.3.0 mobile basics (M1–M3): the ≤520px layout rules
// in frontend/src/css/* (see tests/cssBundle.js) and the small pure
// helpers in frontend/src/desktop.js / mobileNav.js. No React, no DOM
// — the CSS is asserted by extracting the media block, the same
// file-reading approach as tests/visualSystem.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCssBundle } from './cssBundle.js';

const css = readCssBundle();
const roomViewJsx = readFileSync(new URL('../frontend/src/components/RoomView.jsx', import.meta.url), 'utf8');

// The one `@media (max-width: 520px)` block: every phone rule must
// live inside it, so desktop (and the 521–899px tablet range) is
// untouched. Brace-matched extraction, not a regex — the block holds
// nested rules.
export function phoneBlock(source) {
  const start = source.indexOf('@media (max-width: 520px)');
  assert.notEqual(start, -1, 'no max-width: 520px block in the CSS bundle');
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

// --- M2: bottom tab bar ----------------------------------------------------
import { MOBILE_TABS, formatBadgeCount } from '../frontend/src/mobileNav.js';
import { ICON_PATHS } from '../frontend/src/iconPaths.js';

const appJsx = readFileSync(new URL('../frontend/src/App.jsx', import.meta.url), 'utf8');
const homeJsx = readFileSync(new URL('../frontend/src/components/Home.jsx', import.meta.url), 'utf8');
const tabBarJsx = readFileSync(new URL('../frontend/src/components/MobileTabBar.jsx', import.meta.url), 'utf8');

test('M2: the tab bar has the four sections, with icons that exist', () => {
  assert.deepEqual(MOBILE_TABS.map((t) => t.view), ['rooms', 'friends', 'messages', 'profile']);
  assert.deepEqual(MOBILE_TABS.map((t) => t.label), ['Rooms', 'Friends', 'Messages', 'You']);
  for (const t of MOBILE_TABS) {
    assert.ok(ICON_PATHS[t.icon], `tab ${t.view} uses missing icon ${t.icon}`);
  }
  // Exactly one badge slot: DM unread on Messages. Notifications live
  // on the Home header bell, not on a tab.
  assert.deepEqual(MOBILE_TABS.filter((t) => t.badge).map((t) => `${t.view}:${t.badge}`), ['messages:dm']);
});

test('M2: badge counts cap at 9+, and 0 hides the badge', () => {
  assert.equal(formatBadgeCount(0), '');
  assert.equal(formatBadgeCount(undefined), '');
  assert.equal(formatBadgeCount(1), '1');
  assert.equal(formatBadgeCount(9), '9');
  assert.equal(formatBadgeCount(10), '9+');
  assert.equal(formatBadgeCount(42), '9+');
});

test('M2: the phone block hides the top tabs and topbar bell, and shows the pill', () => {
  assert.match(phone, /\.view-tabs \{ display: none; \}/);
  assert.match(phone, /\.topbar \.bell-btn \{ display: none; \}/);
  assert.match(phone, /\.mobile-tab-bar \{[^}]*display: flex;/);
  assert.match(phone, /\.mobile-tab-bar \{[^}]*position: fixed;/);
  assert.match(phone, /\.mobile-tab-bar \{[^}]*bottom: calc\(0\.75rem \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(phone, /\.mobile-tab-bar \{[^}]*height: 3\.5rem;/);
  // The pill is hidden above 520px (tablets keep top tabs, desktop
  // keeps the icon rail).
  assert.match(outsidePhone, /\.mobile-tab-bar, \.home-bell, \.stories-row-wrap \{ display: none; \}/);
});

test('M2: the mini-player sits directly above the tab bar, never overlapping it', () => {
  // Tab bar top edge = bottom offset (0.75rem) + height (3.5rem) =
  // 4.25rem above the safe-area line; the in-call mini-player bottom
  // must clear that with room to spare.
  const tabRule = phone.match(/\.mobile-tab-bar \{([^}]*)\}/);
  assert.ok(tabRule, 'no .mobile-tab-bar rule in the phone block');
  const tabBottom = Number(tabRule[1].match(/bottom: calc\(([0-9.]+)rem/)?.[1]);
  const tabHeight = Number(tabRule[1].match(/height: ([0-9.]+)rem/)?.[1]);
  assert.ok(tabBottom > 0 && tabHeight > 0, 'tab bar bottom/height not parseable');
  const miniRule = phone.match(/\.app--in-call \.mini-player \{([^}]*)\}/);
  assert.ok(miniRule, 'no in-call mini-player rule in the phone block');
  const miniBottom = Number(miniRule[1].match(/bottom: calc\(([0-9.]+)rem/)?.[1]);
  assert.ok(miniBottom > 0, 'mini-player bottom not parseable');
  assert.ok(
    miniBottom >= tabBottom + tabHeight + 0.5,
    `mini-player bottom (${miniBottom}rem) must clear the tab bar top edge (${tabBottom + tabHeight}rem) by >= 0.5rem`
  );
  // And the in-call main padding must clear the stacked pair.
  assert.match(phone, /\.app--in-call \.main \{ padding-bottom: calc\(9\.75rem \+ env\(safe-area-inset-bottom\)\); \}/);
});

test('M2: App renders the tab bar only outside a room view, and Home owns the bell', () => {
  assert.ok(appJsx.includes("import MobileTabBar from './components/MobileTabBar'"));
  assert.match(appJsx, /\{!inRoom && \(\s*<MobileTabBar view=\{view\} dmUnread=\{dmUnread\} onNavigate=\{goTo\} \/>/);
  assert.ok(appJsx.includes('notifUnread={notifUnread} onOpenNotifications={() => goTo(\'notifications\')}'));
  assert.ok(homeJsx.includes('className="icon-btn home-bell"'));
  assert.ok(homeJsx.includes('formatBadgeCount(notifUnread)'));
  assert.ok(tabBarJsx.includes('formatBadgeCount(dmUnread)'));
  // The bell is hidden on phones only via the CSS above — the topbar
  // bell JSX stays for tablets (521–899px), where the tab bar is off.
  assert.ok(appJsx.includes('className="icon-btn bell-btn"'));
});

// --- M3: home polish --------------------------------------------------------
import { storiesFriends } from '../frontend/src/desktop.js';

const storiesJsx = readFileSync(new URL('../frontend/src/components/StoriesRow.jsx', import.meta.url), 'utf8');

test('M3: storiesFriends keeps in-room and online friends, drops away ones', () => {
  const f = (id, status) => ({ id, name: id, status, room: status === 'in-room' ? { id: 'r', name: 'Room' } : null });
  assert.deepEqual(
    storiesFriends([f('a', 'in-room'), f('b', 'online'), f('c', 'away'), f('d', 'online')]).map((x) => x.id),
    ['a', 'b', 'd']
  );
  // Presence order is preserved (the endpoint already sorts in-room
  // first, then online) — no re-sorting here.
  assert.deepEqual(storiesFriends([f('b', 'online'), f('a', 'in-room')]).map((x) => x.id), ['b', 'a']);
  assert.deepEqual(storiesFriends([]), []);
  assert.deepEqual(storiesFriends(null), []);
  assert.deepEqual(storiesFriends([{ id: 'x' }]), []);
});

test('M3: the phone block shows the stories row with a glowing in-room ring', () => {
  assert.match(phone, /\.stories-row-wrap \{ display: block; \}/);
  assert.match(phone, /\.stories-row \{[^}]*display: flex;/);
  assert.match(phone, /\.stories-row \{[^}]*overflow-x: auto;/);
  assert.match(phone, /\.story-avatar\.story-in-room \{[^}]*box-shadow:[^}]*#34d399/);
  assert.match(phone, /\.story-avatar:not\(\.story-in-room\) \{[^}]*box-shadow:/);
  // Hidden above 520px (see the shared base rule asserted in M2).
  assert.ok(!outsidePhone.includes('.stories-row-wrap { display: block; }'));
});

test('M3: the greeting-to-New-room gap is at least 12px on phones', () => {
  const headRule = phone.match(/\.home-head \{([^}]*)\}/);
  assert.ok(headRule, 'no .home-head rule in the phone block');
  const gap = Number(headRule[1].match(/gap: ([0-9.]+)rem/)?.[1]);
  assert.ok(gap >= 0.75, `home-head gap is ${gap}rem, need >= 0.75rem (12px)`);
  // The New room button takes its own full-width row below the
  // greeting, so the gap is the vertical spacing.
  assert.match(phone, /\.home-head \.btn-block \{ flex: 1 1 100%; \}/);
});

test('M3: Home renders the stories row from the same presence data as the side panel', () => {
  assert.ok(homeJsx.includes("import StoriesRow from './StoriesRow'"));
  // Home passes its single presence fetch (shared with the night sky
  // and the side panel) — the stories row must not fetch it a second time.
  // v0.7.0: the join prop is tryJoin, the cap pre-flight wrapper around
  // onJoin — the stories row still joins the same way, through Home.
  assert.ok(homeJsx.includes('<StoriesRow refreshTick={refreshTick} onJoin={tryJoin} friends={presence} />'));
  assert.ok(storiesJsx.includes('friendsProp !== undefined ? friendsProp : ownFriends'), 'stories row must use the shared presence prop when provided');
  assert.ok(storiesJsx.includes("getFriendsPresence"), 'stories row must reuse GET /api/friends/presence');
  assert.ok(storiesJsx.includes("matchMedia('(max-width: 520px)')"), 'stories row must stay off-phone (desktop untouched)');
  assert.ok(storiesJsx.includes('storiesFriends(friends)'));
  // Tap joins that friend's room, like the desktop SidePanel Join.
  assert.ok(storiesJsx.includes("apiJson(`/api/rooms/${friend.room.id}`)"));
  assert.ok(storiesJsx.includes('aria-label={`Join ${f.name} in ${f.room.name}`}'));
});
