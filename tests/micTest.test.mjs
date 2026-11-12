// Tests for the mic test's pure half (v0.7.0,
// frontend/src/micTest.js): RMS level math, the audible threshold,
// and the getUserMedia error wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIC_AUDIBLE_THRESHOLD, HEARD_POLLS,
  rmsLevel, isAudible, classifyMicError
} from '../frontend/src/micTest.js';

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('micTest: rmsLevel — silence is 0, a voice is well above the threshold', () => {
  assert.equal(rmsLevel(new Uint8Array(256).fill(128)), 0);
  assert.equal(rmsLevel(new Uint8Array(0)), 0);
  assert.equal(rmsLevel(null), 0);
  assert.equal(rmsLevel(undefined), 0);
  // A constant offset of 12/128: RMS = 12/128.
  assert.ok(approx(rmsLevel(new Uint8Array(256).fill(140)), 12 / 128));
  // A loud sample (offset 64/128 = 0.5) reads far above threshold.
  assert.ok(rmsLevel(new Uint8Array(256).fill(192)) > MIC_AUDIBLE_THRESHOLD);
  // Same threshold as the voice engine's SPEAK_THRESHOLD (voice.js).
  assert.equal(MIC_AUDIBLE_THRESHOLD, 0.02);
  // A few consecutive polls are needed: one blip must not pass.
  assert.ok(Number.isInteger(HEARD_POLLS) && HEARD_POLLS >= 2);
});

test('micTest: isAudible respects the threshold', () => {
  assert.equal(isAudible(0), false);
  assert.equal(isAudible(0.019), false);
  assert.equal(isAudible(0.02), false); // strictly above
  assert.equal(isAudible(0.021), true);
  assert.equal(isAudible(0.5), true);
  assert.equal(isAudible(NaN), false);
  assert.equal(isAudible(0.1, 0.2), false);
  assert.equal(isAudible(0.3, 0.2), true);
});

test('micTest: classifyMicError — every failure is a friendly message, never a dead end', () => {
  for (const [name, code] of [
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'not-found'],
    ['OverconstrainedError', 'not-found'],
    ['NotReadableError', 'in-use'],
    ['AbortError', 'in-use'],
    ['SomethingElse', 'unavailable'],
    [undefined, 'unavailable']
  ]) {
    const err = name === undefined ? {} : { name };
    const out = classifyMicError(err);
    assert.equal(out.code, code, name);
    assert.ok(out.message.length > 20, `${code} needs a real sentence`);
    // Every path says the user can still join listening-only.
    assert.match(out.message, /listen/i, `${code} must mention listening-only`);
  }
  assert.equal(classifyMicError(null).code, 'unavailable');
  assert.equal(classifyMicError(undefined).code, 'unavailable');
});
