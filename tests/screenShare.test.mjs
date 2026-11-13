// Tests for screen sharing (v0.8.0):
//   - lib/screenShare.js: the one-sharer-per-room registry (pure)
//   - frontend/src/screenShare.js: capability / button / start guards
//   - frontend/src/voiceSession.js: the share actions on the reducer
//   - the wiring: CSS layer (fixed, z-index 0, orbs above), the
//     reduced-motion rule, the screen icon, and RoomView's share UI
//     (dock button, banner, "Tap to view full screen").
// The live relay is tests/screenShareSocket.test.js; the engine's
// track plumbing is tests/voiceShare.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SCREEN_SHARE_BUSY_MESSAGE as SERVER_BUSY_MESSAGE,
  createShareStore, tryClaimShare, releaseShare, sharerForRoom,
  clearSharerForSocket
} from '../lib/screenShare.js';
import {
  SCREEN_SHARE_BUSY_MESSAGE,
  supportsScreenShare, canShowShareButton, canStartSharing
} from '../frontend/src/screenShare.js';
import {
  initialVoiceSessionState, voiceSessionReducer
} from '../frontend/src/voiceSession.js';
import { ICON_PATHS } from '../frontend/src/iconPaths.js';
import { readCssBundle } from './cssBundle.js';

const css = readCssBundle();
const roomViewJsx = readFileSync(new URL('../frontend/src/components/RoomView.jsx', import.meta.url), 'utf8');
const voiceJs = readFileSync(new URL('../frontend/src/voice.js', import.meta.url), 'utf8');
const mainJsx = readFileSync(new URL('../frontend/src/main.jsx', import.meta.url), 'utf8');

// --- the message both sides agree on -------------------------------------

test('client and server share the exact busy message', () => {
  assert.equal(SCREEN_SHARE_BUSY_MESSAGE, 'Someone is already sharing');
  assert.equal(SERVER_BUSY_MESSAGE, SCREEN_SHARE_BUSY_MESSAGE);
});

// --- lib/screenShare.js: one sharer per room ------------------------------

test('tryClaimShare: first claim wins, second user is refused', () => {
  const sharers = createShareStore();
  assert.deepEqual(tryClaimShare(sharers, 'room1', 'user-a', 'sock-a'), { ok: true });
  assert.deepEqual(sharerForRoom(sharers, 'room1'), { userId: 'user-a', socketId: 'sock-a' });
  const refused = tryClaimShare(sharers, 'room1', 'user-b', 'sock-b');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Someone is already sharing');
  assert.equal(refused.sharerUserId, 'user-a');
  // The refusal changes nothing — the first sharer still holds it.
  assert.deepEqual(sharerForRoom(sharers, 'room1'), { userId: 'user-a', socketId: 'sock-a' });
});

test('tryClaimShare: same user re-claiming is idempotent and follows their socket', () => {
  const sharers = createShareStore();
  tryClaimShare(sharers, 'room1', 'user-a', 'sock-a');
  assert.deepEqual(tryClaimShare(sharers, 'room1', 'user-a', 'sock-a2'), { ok: true });
  assert.deepEqual(sharerForRoom(sharers, 'room1'), { userId: 'user-a', socketId: 'sock-a2' });
});

test('tryClaimShare: slots are per room, not global', () => {
  const sharers = createShareStore();
  assert.deepEqual(tryClaimShare(sharers, 'room1', 'user-a', 'sock-a'), { ok: true });
  assert.deepEqual(tryClaimShare(sharers, 'room2', 'user-b', 'sock-b'), { ok: true });
});

test('releaseShare: only the holder releases; a stale stop is a no-op', () => {
  const sharers = createShareStore();
  tryClaimShare(sharers, 'room1', 'user-a', 'sock-a');
  assert.equal(releaseShare(sharers, 'room1', 'user-b'), false);
  assert.deepEqual(sharerForRoom(sharers, 'room1'), { userId: 'user-a', socketId: 'sock-a' });
  assert.equal(releaseShare(sharers, 'room1', 'user-a'), true);
  assert.equal(sharerForRoom(sharers, 'room1'), null);
  assert.equal(releaseShare(sharers, 'room1', 'user-a'), false);
});

test('clearSharerForSocket: a leaving socket frees its slot and names the room', () => {
  const sharers = createShareStore();
  tryClaimShare(sharers, 'room1', 'user-a', 'sock-a');
  tryClaimShare(sharers, 'room2', 'user-b', 'sock-b');
  assert.deepEqual(clearSharerForSocket(sharers, 'sock-a'), { roomId: 'room1', userId: 'user-a' });
  assert.equal(sharerForRoom(sharers, 'room1'), null);
  assert.deepEqual(sharerForRoom(sharers, 'room2'), { userId: 'user-b', socketId: 'sock-b' });
  assert.equal(clearSharerForSocket(sharers, 'sock-nobody'), null);
});

// --- frontend/src/screenShare.js: capability + guards ---------------------

test('supportsScreenShare: only a getDisplayMedia function counts', () => {
  assert.equal(supportsScreenShare({ getDisplayMedia: () => {} }), true);
  assert.equal(supportsScreenShare({}), false);
  assert.equal(supportsScreenShare(undefined), false);
  assert.equal(supportsScreenShare(null), false);
  assert.equal(supportsScreenShare({ getDisplayMedia: 'nope' }), false);
});

test('canShowShareButton: desktop + capable only — phones are view-only', () => {
  const capable = { getDisplayMedia: () => {} };
  assert.equal(canShowShareButton({ mediaDevices: capable, isPhone: false }), true);
  assert.equal(canShowShareButton({ mediaDevices: capable, isPhone: true }), false);
  assert.equal(canShowShareButton({ mediaDevices: {}, isPhone: false }), false);
  assert.equal(canShowShareButton({ mediaDevices: undefined, isPhone: false }), false);
});

test('canStartSharing: free slot or my own slot only', () => {
  assert.equal(canStartSharing({ sharerUserId: null, selfId: 'me' }), true);
  assert.equal(canStartSharing({ sharerUserId: undefined, selfId: 'me' }), true);
  assert.equal(canStartSharing({ sharerUserId: 'me', selfId: 'me' }), true);
  assert.equal(canStartSharing({ sharerUserId: 'them', selfId: 'me' }), false);
});

// --- voiceSession.js: share actions ----------------------------------------

test('share-started records the sharer; isMine marks my own share', () => {
  const active = voiceSessionReducer(initialVoiceSessionState, { type: 'join', joinedAt: 1000 });
  const peer = voiceSessionReducer(active, { type: 'share-started', userId: 'user-b', name: 'Priya', isMine: false });
  assert.equal(peer.sharing, false);
  assert.equal(peer.screenSharerId, 'user-b');
  assert.equal(peer.screenSharerName, 'Priya');
  assert.equal(peer.shareError, '');
  const mine = voiceSessionReducer(active, { type: 'share-started', userId: 'me', name: 'Me', isMine: true });
  assert.equal(mine.sharing, true);
  assert.equal(mine.screenSharerId, 'me');
});

test('share-stopped clears only the current sharer; a stale stop is ignored', () => {
  const active = voiceSessionReducer(initialVoiceSessionState, { type: 'join', joinedAt: 1000 });
  const sharing = voiceSessionReducer(active, { type: 'share-started', userId: 'user-b', name: 'Priya', isMine: false });
  assert.equal(voiceSessionReducer(sharing, { type: 'share-stopped', userId: 'user-a' }), sharing);
  const stopped = voiceSessionReducer(sharing, { type: 'share-stopped', userId: 'user-b' });
  assert.equal(stopped.sharing, false);
  assert.equal(stopped.screenSharerId, null);
  assert.equal(stopped.screenSharerName, '');
  // My own stop (no userId) always clears.
  const mine = voiceSessionReducer(active, { type: 'share-started', userId: 'me', name: 'Me', isMine: true });
  assert.equal(voiceSessionReducer(mine, { type: 'share-stopped' }).sharing, false);
});

test('share-error records the refusal and clears on demand', () => {
  const active = voiceSessionReducer(initialVoiceSessionState, { type: 'join', joinedAt: 1000 });
  const err = voiceSessionReducer(active, { type: 'share-error', error: 'Someone is already sharing' });
  assert.equal(err.shareError, 'Someone is already sharing');
  assert.equal(voiceSessionReducer(err, { type: 'share-clear-error' }).shareError, '');
});

test('join and leave reset the share state', () => {
  const active = voiceSessionReducer(initialVoiceSessionState, { type: 'join', joinedAt: 1000 });
  const sharing = voiceSessionReducer(active, { type: 'share-started', userId: 'me', name: 'Me', isMine: true });
  assert.deepEqual(voiceSessionReducer(sharing, { type: 'leave' }), initialVoiceSessionState);
  const rejoined = voiceSessionReducer(sharing, { type: 'join', joinedAt: 2000 });
  assert.equal(rejoined.sharing, false);
  assert.equal(rejoined.screenSharerId, null);
  assert.equal(rejoined.shareError, '');
});

// --- icon ------------------------------------------------------------------

test('screen icon: a monitor outline in iconPaths.js', () => {
  assert.ok(ICON_PATHS.screen, 'screen icon must exist');
  const rect = ICON_PATHS.screen.find((el) => el.el === 'rect');
  assert.ok(rect, 'screen icon must draw the monitor rect');
  assert.equal(rect.x, 2);
  assert.equal(rect.y, 3);
  assert.equal(rect.width, 20);
  assert.equal(rect.height, 14);
});

// --- CSS: the share layer ---------------------------------------------------

test('share layer: fixed, z-index 0, behind the orbs at z-index 2', () => {
  assert.ok(css.includes('.share-layer'), 'share.css must define .share-layer');
  assert.match(css, /\.share-layer\s*\{[^}]*position:\s*fixed/, 'share layer must be position:fixed');
  assert.match(css, /\.share-layer\s*\{[^}]*z-index:\s*0/, 'share layer must sit at z-index:0');
  assert.match(css, /\.orb-wrap\s*\{[^}]*z-index:\s*2/, 'orbs must stay in front at z-index:2');
  assert.ok(css.includes('.sharing-banner'), 'the "You are sharing" banner must be styled');
  assert.ok(css.includes('.voice-btn.sharing'), 'the dock button must show its sharing state');
});

test('reduced motion: no animated transitions on the share layer', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'reduced-motion block must exist');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('.share-layer'), 'reduced-motion block must name the share layer');
  assert.match(reduced, /\.share-layer[\s\S]*?animation:\s*none/, 'reduced motion must still the share layer');
  // By construction the layer has no animation/transition at all —
  // grep the share rules for any animation or transition property.
  const layerBlock = css.slice(css.indexOf('.share-layer {'), css.indexOf('.share-video {'));
  assert.equal(/animation|transition/.test(layerBlock), false, 'share layer must not animate, period');
});

test('share.css is imported by main.jsx (so the bundle carries it)', () => {
  assert.ok(mainJsx.includes("import './css/share.css';"), 'main.jsx must import share.css');
  // The single ≤520px phone block is untouched — the Share button is
  // hidden on phones by JS (RoomView's matchMedia), not by CSS.
  const count = (css.match(/@media \(max-width: 520px\)/g) || []).length;
  assert.equal(count, 1);
});

// --- RoomView wiring --------------------------------------------------------

test('RoomView: dock button, banner, layer, fullscreen affordance', () => {
  for (const needle of [
    "Icon name=\"screen\"",
    'voice-btn--share',
    'You are sharing your screen',
    'share-layer',
    'Tap to view full screen',
    'screen-share-started',
    'screen-share-stopped',
    'SCREEN_SHARE_BUSY_MESSAGE',
    "matchMedia('(max-width: 520px)')"
  ]) {
    assert.ok(roomViewJsx.includes(needle), `RoomView must contain ${needle}`);
  }
  // The share button is gated on canShare (desktop + capable), never
  // rendered unconditionally.
  assert.ok(roomViewJsx.includes('{canShare && ('), 'Share button must be gated on canShare');
});

// --- voice.js wiring (source-level: the audio path is untouched) -----------

test('voice.js: video-only capture, separate from the audio path', () => {
  assert.ok(voiceJs.includes('getDisplayMedia({ video: true, audio: false })'), 'capture must be video-only');
  assert.ok(voiceJs.includes('startScreenShare'), 'engine must expose startScreenShare');
  assert.ok(voiceJs.includes('stopScreenShare'), 'engine must expose stopScreenShare');
  assert.ok(voiceJs.includes('removeTrack'), 'stopping must removeTrack the video sender');
  assert.ok(voiceJs.includes("e.track?.kind === 'video'"), 'ontrack must split video from audio');
  // The mic track is never re-added by the share path: addTrack with
  // the share stream happens only in _addShareTrackToPeer, and the
  // audio addTrack in _createPeer still uses localStream.
  assert.ok(voiceJs.includes('pc.addTrack(t, this.localStream)'), 'audio tracks still come from localStream');
});
