// Tests for the visual system (v0.2.0): the hand-rolled icon set,
// the orb signal-bars helper, and the socket-pushed room updates.
// Pure modules only — no React, no DOM, no MongoDB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ICON_PATHS } from '../frontend/src/iconPaths.js';
import { signalLevel } from '../frontend/src/signalLevel.js';
import { emitRoomsChanged } from '../lib/socket.js';

// Every icon the app renders (grep `name="` in components/icons.jsx
// usages). If a component uses an icon that is not here, Icon renders
// nothing — so this list failing is the loud signal.
const ICONS_IN_USE = [
  'planet', 'bell', 'mic', 'mic-off', 'headphones', 'headphones-off',
  'chat', 'phone', 'users', 'user', 'user-plus', 'search', 'plus', 'x',
  'check', 'check-circle', 'chevron-left', 'send', 'lock', 'knock', 'globe',
  'mail', 'crown', 'shield', 'image', 'volume', 'home', 'link'
];

test('icon set: every icon the app uses exists', () => {
  for (const name of ICONS_IN_USE) {
    assert.ok(ICON_PATHS[name], `missing icon: ${name}`);
    assert.ok(Array.isArray(ICON_PATHS[name]) && ICON_PATHS[name].length > 0, `empty icon: ${name}`);
  }
});

test('icon set: every element is a valid SVG descriptor, no emoji', () => {
  const emoji = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF]/u;
  const known = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
  for (const [name, els] of Object.entries(ICON_PATHS)) {
    for (const el of els) {
      assert.ok(known.has(el.el), `${name}: unknown element ${el.el}`);
      assert.equal(emoji.test(JSON.stringify(el)), false, `${name}: emoji in icon data`);
      if (el.el === 'path') assert.match(el.d, /^[Mm]/, `${name}: path must start with M/m`);
      if (el.el === 'circle') {
        assert.equal(typeof el.cx, 'number', `${name}: circle cx`);
        assert.equal(typeof el.cy, 'number', `${name}: circle cy`);
        assert.ok(el.r > 0, `${name}: circle r`);
      }
      if (el.el === 'ellipse') {
        assert.ok(el.rx > 0 && el.ry > 0, `${name}: ellipse radii`);
      }
      if (el.el === 'rect') {
        assert.ok(el.width > 0 && el.height > 0, `${name}: rect size`);
      }
    }
  }
});

test('icon set: no icon name is an emoji or blank', () => {
  for (const name of Object.keys(ICON_PATHS)) {
    assert.match(name, /^[a-z][a-z0-9-]*$/, `bad icon name: ${name}`);
  }
});

// The rail and the activity feed render SVG icons, not emoji — the
// v0.2.0 visual pass missed these files and the v0.2.1 review caught
// them (IconRail used planet/people/chat/bell emoji; SidePanel used
// wave/check/lock/chat emoji). If an emoji creeps back into one of
// these files, this fails. Deliberately scoped to the icon UI: emoji
// in copy elsewhere (and in code comments) is not covered here.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF]/u;
const ICON_UI_FILES = [
  '../frontend/src/components/IconRail.jsx',
  '../frontend/src/components/SidePanel.jsx',
  '../frontend/src/components/HeroCard.jsx',
  '../frontend/src/components/MiniPlayer.jsx'
];

test('icon rail and activity feed: no emoji glyphs in icon UI', () => {
  for (const rel of ICON_UI_FILES) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.equal(EMOJI.test(src), false, `${rel} contains an emoji glyph`);
  }
});

test('signalLevel: connected is 4 green bars', () => {
  assert.deepEqual(signalLevel('connected'), { bars: 4, tone: 'connected' });
});

test('signalLevel: connecting states are 2 amber bars', () => {
  for (const state of ['checking', 'connecting', 'new', undefined, 'something-else']) {
    assert.deepEqual(signalLevel(state), { bars: 2, tone: 'connecting' }, `state ${state}`);
  }
});

test('signalLevel: failed states are 1 red bar', () => {
  for (const state of ['disconnected', 'failed', 'closed']) {
    assert.deepEqual(signalLevel(state), { bars: 1, tone: 'failed' }, `state ${state}`);
  }
});

test('emitRoomsChanged: no-op (false) before socket.io is attached', () => {
  assert.doesNotThrow(() => {
    assert.equal(emitRoomsChanged('507f1f77bcf86cd799439011'), false);
    assert.equal(emitRoomsChanged(), false);
  });
});
