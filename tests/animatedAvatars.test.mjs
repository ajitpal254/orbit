// Tests for the animated character avatars (v0.7.0): the character
// registry (lib/avatars.js + frontend/src/avatars.js), the hand-drawn
// SVG art (frontend/src/characters.js), the reduced-motion static
// frame, and the Profile picker + Avatar/orb wiring (source-level,
// same pattern as tests/mobile.test.mjs).
//
// Pure modules only — no React, no DOM, no MongoDB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const backend = require('../lib/avatars.js');
const frontend = await import('../frontend/src/avatars.js');
const characters = await import('../frontend/src/characters.js');
const { validateProfileUpdate } = require('../lib/profile.js');

import { readCssBundle } from './cssBundle.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const CHARACTER_MOTIONS = new Set([
  'bob', 'glow', 'float', 'sway', 'drift', 'bounce', 'hop', 'wobble'
]);
const HEX = /^#[0-9a-f]{6}$/i;
const GRADIENT_IDS = ['nova', 'aurora', 'ember', 'tide', 'comet', 'bloom', 'sol', 'nebula'];
const KNOWN_ELEMENTS = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);

test('backend character list is well-formed: 8 unique char- ids', () => {
  assert.equal(backend.AVATAR_CHARACTERS.length, 8, 'exactly 8 characters');
  const ids = new Set();
  for (const c of backend.AVATAR_CHARACTERS) {
    assert.match(c.id, /^char-[a-z]+$/, `${c.id} is a char- id`);
    assert.equal(typeof c.name, 'string');
    assert.ok(c.name.length > 0);
    assert.ok(HEX.test(c.from), `${c.id} from is a hex color`);
    assert.ok(HEX.test(c.to), `${c.id} to is a hex color`);
    assert.ok(CHARACTER_MOTIONS.has(c.motion), `${c.id} has a known motion`);
    assert.ok(!ids.has(c.id), `${c.id} is unique`);
    ids.add(c.id);
  }
  assert.deepEqual(backend.AVATAR_CHARACTER_IDS, backend.AVATAR_CHARACTERS.map((c) => c.id));
});

test('frontend character list matches the backend list exactly', () => {
  assert.deepEqual(frontend.AVATAR_CHARACTERS, backend.AVATAR_CHARACTERS);
  assert.deepEqual(frontend.AVATAR_CHARACTER_IDS, backend.AVATAR_CHARACTER_IDS);
});

test('isValidAvatarPreset accepts characters AND gradients, rejects the rest', () => {
  for (const id of backend.AVATAR_CHARACTER_IDS) {
    assert.equal(backend.isValidAvatarPreset(id), true, `${id} valid`);
    assert.equal(frontend.isValidAvatarPreset(id), true, `${id} valid (frontend)`);
  }
  for (const id of GRADIENT_IDS) {
    assert.equal(backend.isValidAvatarPreset(id), true, `${id} still valid`);
  }
  assert.equal(backend.isValidAvatarPreset('char-nope'), false);
  assert.equal(backend.isValidAvatarPreset('nope'), false);
  assert.equal(backend.isValidAvatarPreset(null), false);
  assert.equal(backend.isValidAvatarPreset(undefined), false);
  assert.equal(backend.isValidAvatarPreset(42), false);
  assert.equal(backend.isValidAvatarPreset(''), false);
});

test('avatarCharacterById resolves characters and null for unknown ids', () => {
  assert.equal(backend.avatarCharacterById('char-fox').name, 'Foxy');
  assert.equal(backend.avatarCharacterById('char-ghost').name, 'Boo');
  assert.equal(backend.avatarCharacterById('nova'), null, 'gradient id is not a character');
  assert.equal(backend.avatarCharacterById('char-nope'), null);
  assert.equal(frontend.avatarCharacterById('char-cat').name, 'Miso');
});

test('gradient presets are unchanged (backward compat)', () => {
  assert.deepEqual(backend.AVATAR_PRESET_IDS, GRADIENT_IDS);
  assert.deepEqual(frontend.AVATAR_PRESET_IDS, GRADIENT_IDS);
  // No id collision between the two namespaces.
  const overlap = backend.AVATAR_PRESET_IDS.filter((id) => backend.AVATAR_CHARACTER_IDS.includes(id));
  assert.deepEqual(overlap, []);
});

test('PATCH /api/users/me validation accepts a character, rejects unknown ids', () => {
  assert.equal(validateProfileUpdate({ avatarPreset: 'char-fox' }).ok, true);
  assert.equal(validateProfileUpdate({ avatarPreset: 'char-frog' }).ok, true);
  assert.equal(validateProfileUpdate({ avatarPreset: 'nova' }).ok, true, 'gradient still accepted');
  const bad = validateProfileUpdate({ avatarPreset: 'char-nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'Unknown avatar preset');
});

test('characterSvg resolves every character id to standalone SVG markup', () => {
  assert.deepEqual(characters.CHARACTER_IDS, backend.AVATAR_CHARACTER_IDS);
  for (const id of characters.CHARACTER_IDS) {
    const svg = characters.characterSvg(id);
    assert.equal(typeof svg, 'string', `${id} resolves to a string`);
    assert.match(svg, /^<svg /, `${id} starts with <svg`);
    assert.ok(svg.includes('viewBox="0 0 64 64"'), `${id} has the 64x64 viewBox`);
    assert.ok(svg.includes(`data-char="${id}"`), `${id} carries its id`);
    const meta = backend.avatarCharacterById(id);
    assert.ok(svg.includes(`<title>${meta.name}</title>`), `${id} names ${meta.name}`);
    assert.ok(svg.includes(`char-grad-${id}`), `${id} has its own gradient def`);
    assert.ok(svg.includes(`fill="url(#char-grad-${id})"`), `${id} backdrop uses its gradient`);
    assert.ok(svg.length > 400, `${id} has real art, not an empty shell`);
    // No external resources, no scripts, no images to download. (The
    // xmlns="http://www.w3.org/2000/svg" namespace string is not a
    // fetch — strip it before checking for URLs.)
    assert.equal(svg.includes('<script'), false, `${id}: no script`);
    assert.equal(svg.includes('<image'), false, `${id}: no raster image`);
    assert.equal(svg.includes('href'), false, `${id}: no links`);
    assert.equal(
      svg.replace('xmlns="http://www.w3.org/2000/svg"', '').includes('http'),
      false,
      `${id}: no external URL`
    );
  }
  assert.equal(characters.characterSvg('char-nope'), null);
  assert.equal(characters.characterSvg('nova'), null, 'gradient id has no character art');
  assert.equal(characters.characterSvg(null), null);
});

test('character art uses only known SVG elements, in-bounds, no emoji', () => {
  const emoji = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF]/u;
  for (const id of characters.CHARACTER_IDS) {
    const parts = characters.characterArtById(id);
    assert.ok(Array.isArray(parts) && parts.length >= 8, `${id} has enough parts to read as a character`);
    for (const el of parts) {
      assert.ok(KNOWN_ELEMENTS.has(el.el), `${id}: unknown element ${el.el}`);
      assert.equal(emoji.test(JSON.stringify(el)), false, `${id}: no emoji in art data`);
      if (el.el === 'path') assert.match(el.d, /^[Mm]/, `${id}: path must start with M/m`);
      if (el.el === 'circle' || el.el === 'ellipse') {
        assert.ok(el.cx >= 0 && el.cx <= 64, `${id}: cx in bounds`);
        assert.ok(el.cy >= 0 && el.cy <= 64, `${id}: cy in bounds`);
      }
      if (el.el === 'rect') {
        assert.ok(el.x >= 0 && el.x <= 64 && el.y >= 0 && el.y <= 64, `${id}: rect in bounds`);
      }
    }
    // Every character blinks (or otherwise moves a named part) — the
    // set is animated, not 8 static pictures.
    const classes = parts.map((p) => p.class).filter(Boolean);
    assert.ok(classes.length > 0, `${id} has at least one animated part`);
  }
});

test('every character has a distinct looping motion', () => {
  const motions = backend.AVATAR_CHARACTERS.map((c) => c.motion);
  assert.equal(new Set(motions).size, motions.length, 'motions are all different');
  assert.deepEqual(
    motions,
    ['bob', 'glow', 'float', 'sway', 'drift', 'bounce', 'hop', 'wobble'],
    'the eight motions, in character order'
  );
});

test('reduced motion: character CSS stills every animation', () => {
  const css = read('../frontend/src/components/CharacterAvatar.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'reduced-motion block exists');
  assert.match(css, /animation: none !important/, 'animations are switched off, not slowed');
  // Each character has its own root animation rule.
  for (const id of characters.CHARACTER_IDS) {
    assert.ok(css.includes(`.char-${id}`), `${id} has a CSS animation rule`);
  }
  // No new CSS leaked into the shared stylesheet (now the split
  // css/ bundle read via main.jsx — see tests/cssBundle.js).
  assert.equal(readCssBundle().includes('char-art'), false, 'shared CSS untouched by characters');
});

test('Profile picker lists all 8 characters alongside the gradients', () => {
  const profile = read('../frontend/src/components/Profile.jsx');
  assert.ok(profile.includes('AVATAR_CHARACTERS'), 'Profile imports the character list');
  assert.ok(profile.includes('Or pick a character'), 'characters section heading');
  assert.ok(profile.includes('aria-label="Avatar characters"'), 'characters radiogroup');
  assert.ok(profile.includes('AVATAR_CHARACTERS.map'), 'Profile maps over all characters');
  assert.ok(profile.includes('Or pick an animated avatar'), 'gradient picker still present');
  assert.ok(profile.includes('AVATAR_PRESETS.map'), 'gradient picker still maps presets');
});

test('Avatar renders characters before gradients, photo first (precedence)', () => {
  const avatar = read('../frontend/src/components/Avatar.jsx');
  assert.ok(avatar.includes('avatarCharacterById'), 'Avatar resolves characters');
  assert.ok(avatar.includes('CharacterArt'), 'Avatar renders the character art');
  assert.ok(
    avatar.indexOf('if (u.avatarImage)') < avatar.indexOf('const character = avatarCharacterById'),
    'photo check still comes first'
  );
  assert.ok(
    avatar.indexOf('const character = avatarCharacterById') < avatar.indexOf('const preset = avatarPresetById'),
    'character check comes before the gradient preset check'
  );
});

test('room orbs render the character instead of initials', () => {
  const roomView = read('../frontend/src/components/RoomView.jsx');
  assert.ok(roomView.includes('avatarCharacterById'), 'RoomView resolves the orb owner character');
  assert.ok(roomView.includes('orb-character'), 'orb has a character slot');
  assert.ok(roomView.includes('<CharacterArt'), 'orb renders the character art');
  assert.ok(roomView.includes('orb-initials'), 'initials fallback still present for non-character orbs');
});
