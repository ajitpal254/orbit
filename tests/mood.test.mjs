// Tests for mood glow (v0.7.0): the three orb moods — client
// (frontend/src/mood.js) and server (lib/mood.js) must agree on
// the states and the default, and PATCH /api/users/me must accept
// only those states (lib/profile.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  MOODS, DEFAULT_MOOD, MOOD_META,
  isValidMood, normalizeMood, moodLabel, moodShort
} from '../frontend/src/mood.js';

const require = createRequire(import.meta.url);
const serverMood = require('../lib/mood.js');
const { validateProfileUpdate, profileJson } = require('../lib/profile.js');

test('mood: exactly three states, free by default', () => {
  assert.deepEqual(MOODS, ['free', 'busy', 'chilling']);
  assert.equal(DEFAULT_MOOD, 'free');
  // Server mirror agrees — a drift here means the client and the
  // API accept different moods.
  assert.deepEqual(serverMood.MOODS, MOODS);
  assert.equal(serverMood.DEFAULT_MOOD, DEFAULT_MOOD);
});

test('mood: every state has a label, a short name, a colour and a distinct pulse speed', () => {
  const pulses = new Set();
  for (const m of MOODS) {
    const meta = MOOD_META[m];
    assert.ok(meta.label.length > 0, `${m} needs a label`);
    assert.ok(meta.short.length > 0, `${m} needs a short name`);
    assert.match(meta.color, /^#[0-9a-f]{6}$/, `${m} needs a hex colour`);
    assert.ok(Number.isFinite(meta.pulseSeconds) && meta.pulseSeconds > 0);
    pulses.add(meta.pulseSeconds);
  }
  // The pulse speed is the non-colour cue: three states, three speeds.
  assert.equal(pulses.size, 3, 'each mood pulses at its own speed');
});

test('mood: validation and normalization', () => {
  for (const m of MOODS) assert.equal(isValidMood(m), true);
  assert.equal(isValidMood('Free'), false);
  assert.equal(isValidMood(''), false);
  assert.equal(isValidMood(undefined), false);
  assert.equal(isValidMood(null), false);
  assert.equal(normalizeMood('busy'), 'busy');
  assert.equal(normalizeMood('nonsense'), 'free');
  assert.equal(normalizeMood(undefined), 'free');
  assert.equal(normalizeMood(null), 'free');
  // Server mirror normalizes the same way.
  assert.equal(serverMood.normalizeMood('chilling'), 'chilling');
  assert.equal(serverMood.normalizeMood('nope'), 'free');
  assert.equal(moodLabel('busy'), 'Busy — quiet please');
  assert.equal(moodLabel('unknown'), 'Free to talk');
  assert.equal(moodShort('chilling'), 'Chilling');
});

test('mood: PATCH validation accepts the three states, rejects the rest', () => {
  for (const m of MOODS) {
    const r = validateProfileUpdate({ mood: m });
    assert.equal(r.ok, true, m);
    assert.equal(r.updates.mood, m);
  }
  assert.equal(validateProfileUpdate({ mood: 'happy' }).ok, false);
  assert.equal(validateProfileUpdate({ mood: '' }).ok, false);
  assert.equal(validateProfileUpdate({ mood: 1 }).ok, false);
  // Mood can ride with the other profile fields in one PATCH.
  assert.deepEqual(
    validateProfileUpdate({ name: 'Ajit', mood: 'busy' }).updates,
    { name: 'Ajit', mood: 'busy' }
  );
});

test('mood: profileJson carries the mood, defaulting legacy rows to free', () => {
  const base = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Ajit', email: 'a@b.c' };
  assert.equal(profileJson({ ...base, mood: 'chilling' }).mood, 'chilling');
  assert.equal(profileJson(base).mood, 'free');
  assert.equal(profileJson({ ...base, mood: 'weird' }).mood, 'free');
});
