// Screen sharing — pure client helpers (v0.8.0).
//
// No React, no DOM, no voice engine: RoomView passes in what it knows
// (the browser's mediaDevices, the phone media query, the current
// sharer) and these functions decide. Unit-tested in
// tests/screenShare.test.mjs. The live state (who is sharing, am I
// sharing) lives in the voice-session reducer (voiceSession.js); the
// track plumbing lives in the engine (voice.js).

// The exact message the server sends when the room's one share slot
// is already held — the client matches on this string (and the
// 'screen-share-busy' code) to roll a refused local share back.
export const SCREEN_SHARE_BUSY_MESSAGE = 'Someone is already sharing';

// getDisplayMedia is the whole capability: desktop Chrome / Edge /
// Firefox / Safari have it; most mobile browsers do not, which is why
// sharing is view-only on phones (the button never renders there).
// mediaDevices is injected so tests can pass a stub — the real caller
// passes navigator.mediaDevices.
export function supportsScreenShare(mediaDevices) {
  return typeof mediaDevices?.getDisplayMedia === 'function';
}

// The Share button renders only on a non-phone viewport with a
// browser that can capture a screen. Phones are view-only: they see
// the share layer, never the button.
export function canShowShareButton({ mediaDevices, isPhone }) {
  return supportsScreenShare(mediaDevices) && !isPhone;
}

// May I start sharing right now? Only when nobody holds the slot, or
// I already hold it (a re-click while sharing is a no-op, not an
// error). The server is the final arbiter — a race between two
// clickers is refused there with SCREEN_SHARE_BUSY_MESSAGE — this is
// the local fast path so the button can refuse without a round trip.
export function canStartSharing({ sharerUserId, selfId }) {
  if (!sharerUserId) return true;
  return String(sharerUserId) === String(selfId);
}
