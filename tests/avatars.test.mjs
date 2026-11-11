// Tests for the animated avatar presets (lib/avatars.js + the
// frontend copy in frontend/src/avatars.js).
//
// The two lists cannot share one module file across the CJS/ESM
// boundary, so this test asserts they stay identical — same ids, in
// the same order, with valid gradients and motion variants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const backend = require('../lib/avatars.js');
const frontend = await import('../frontend/src/avatars.js');

const MOTIONS = new Set([
  'pulse', 'float', 'glow', 'shimmer', 'spin', 'wave', 'twinkle', 'breathe'
]);
const HEX = /^#[0-9a-f]{6}$/i;

test('backend preset list is well-formed', () => {
  assert.ok(backend.AVATAR_PRESETS.length >= 6, 'at least 6 presets');
  const ids = new Set();
  for (const p of backend.AVATAR_PRESETS) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.name, 'string');
    assert.ok(p.name.length > 0);
    assert.ok(HEX.test(p.from), `${p.id} from is a hex color`);
    assert.ok(HEX.test(p.to), `${p.id} to is a hex color`);
    assert.ok(MOTIONS.has(p.motion), `${p.id} has a known motion`);
    assert.ok(!ids.has(p.id), `${p.id} is unique`);
    ids.add(p.id);
  }
  assert.deepEqual(backend.AVATAR_PRESET_IDS, backend.AVATAR_PRESETS.map((p) => p.id));
});

test('isValidAvatarPreset accepts only known ids', () => {
  assert.equal(backend.isValidAvatarPreset('nova'), true);
  assert.equal(backend.isValidAvatarPreset('nebula'), true);
  assert.equal(backend.isValidAvatarPreset('nope'), false);
  assert.equal(backend.isValidAvatarPreset(null), false);
  assert.equal(backend.isValidAvatarPreset(undefined), false);
  assert.equal(backend.isValidAvatarPreset(42), false);
});

test('avatarPresetById resolves presets and null for unknown ids', () => {
  assert.equal(backend.avatarPresetById('ember').name, 'Ember');
  assert.equal(backend.avatarPresetById('nope'), null);
});

test('frontend preset list matches the backend list exactly', () => {
  assert.deepEqual(frontend.AVATAR_PRESETS, backend.AVATAR_PRESETS);
  assert.deepEqual(frontend.AVATAR_PRESET_IDS, backend.AVATAR_PRESET_IDS);
  assert.equal(frontend.isValidAvatarPreset('tide'), true);
  assert.equal(frontend.isValidAvatarPreset('nope'), false);
});
