// No-audio environment: with no window/AudioContext at all, the sound
// functions must be silent no-ops and never throw. Runs in its own
// process (node:test runs each file separately), so the module-level
// cached context from sounds.test.mjs cannot leak in here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playJoinSound, playMuteSound, playDeafenSound } from '../frontend/src/sounds.js';

test('no AudioContext available -> calls never throw', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.doesNotThrow(() => {
    playJoinSound();
    playMuteSound(true);
    playMuteSound(false);
    playDeafenSound(true);
    playDeafenSound(false);
  });
});
