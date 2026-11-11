// Tests for the persistent-voice session state (frontend/src/
// voiceSession.js, ESM — run via node --test *.test.mjs). The reducer
// is the single source of truth App.jsx, RoomView and MiniPlayer share:
// mute / deafen / moderator-mute and the call timer must agree no
// matter which control toggled them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialVoiceSessionState,
  voiceSessionReducer,
  formatCallDuration
} from '../frontend/src/voiceSession.js';

test('formatCallDuration counts up mm:ss, then h:mm:ss', () => {
  assert.equal(formatCallDuration(0), '0:00');
  assert.equal(formatCallDuration(7000), '0:07');
  assert.equal(formatCallDuration(59999), '0:59');
  assert.equal(formatCallDuration(60000), '1:00');
  assert.equal(formatCallDuration(754000), '12:34');
  assert.equal(formatCallDuration(3599000), '59:59');
  assert.equal(formatCallDuration(3600000), '1:00:00');
  assert.equal(formatCallDuration(3723000), '1:02:03');
});

test('formatCallDuration never goes negative or NaN', () => {
  assert.equal(formatCallDuration(-5000), '0:00');
  assert.equal(formatCallDuration(undefined), '0:00');
  assert.equal(formatCallDuration(null), '0:00');
});

test('join starts an active session and resets mute state', () => {
  const muted = voiceSessionReducer(initialVoiceSessionState, { type: 'set-muted', muted: true });
  const joined = voiceSessionReducer(muted, { type: 'join', joinedAt: 1000 });
  assert.equal(joined.status, 'active');
  assert.equal(joined.joinedAt, 1000);
  assert.equal(joined.muted, false);
  assert.equal(joined.deafened, false);
  assert.equal(joined.modMuted, false);
  assert.equal(joined.modMutedBy, '');
});

test('join without an explicit joinedAt stamps the call start', () => {
  const before = Date.now();
  const joined = voiceSessionReducer(initialVoiceSessionState, { type: 'join' });
  assert.ok(joined.joinedAt >= before && joined.joinedAt <= Date.now());
});

test('leave resets the session to idle', () => {
  const active = voiceSessionReducer(initialVoiceSessionState, { type: 'join', joinedAt: 1000 });
  const muted = voiceSessionReducer(active, { type: 'set-muted', muted: true });
  assert.deepEqual(voiceSessionReducer(muted, { type: 'leave' }), initialVoiceSessionState);
});

test('set-muted and set-deafened toggle independently', () => {
  const active = voiceSessionReducer(initialVoiceSessionState, { type: 'join', joinedAt: 1000 });
  const muted = voiceSessionReducer(active, { type: 'set-muted', muted: true });
  assert.equal(muted.muted, true);
  assert.equal(muted.deafened, false);
  const deafened = voiceSessionReducer(muted, { type: 'set-deafened', deafened: true });
  assert.equal(deafened.muted, true);
  assert.equal(deafened.deafened, true);
  const unmuted = voiceSessionReducer(deafened, { type: 'set-muted', muted: false });
  assert.equal(unmuted.muted, false);
  assert.equal(unmuted.deafened, true);
});

test('set-mod-muted mutes me and records who, unmute clears both', () => {
  const active = voiceSessionReducer(initialVoiceSessionState, { type: 'join', joinedAt: 1000 });
  const modMuted = voiceSessionReducer(active, { type: 'set-mod-muted', muted: true, by: 'Priya' });
  assert.equal(modMuted.modMuted, true);
  assert.equal(modMuted.muted, true);
  assert.equal(modMuted.modMutedBy, 'Priya');
  const cleared = voiceSessionReducer(modMuted, { type: 'set-mod-muted', muted: false, by: '' });
  assert.equal(cleared.modMuted, false);
  assert.equal(cleared.muted, false);
  assert.equal(cleared.modMutedBy, '');
});

test('unknown actions leave the state untouched', () => {
  const active = voiceSessionReducer(initialVoiceSessionState, { type: 'join', joinedAt: 1000 });
  assert.equal(voiceSessionReducer(active, { type: 'nope' }), active);
});

test('reducer never mutates the previous state', () => {
  const active = voiceSessionReducer(initialVoiceSessionState, { type: 'join', joinedAt: 1000 });
  const snapshot = { ...active };
  voiceSessionReducer(active, { type: 'set-muted', muted: true });
  assert.deepEqual(active, snapshot);
});
