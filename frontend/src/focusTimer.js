// Pure client derivation for the Together-mode focus timer
// (frontend/src/focusTimer.js). The server broadcasts a session as
// { startedAt, durationSec } and every client derives the same
// remaining time from those two numbers — never from a local countdown
// that would drift between clients, and never from a server-computed
// "remaining" that would go stale between renders.
//
// Pure + testable: no React, no sockets, no timers. `now` is injected
// (defaults to Date.now) so tests can prove the boundary behaviour
// without waiting.

export const FOCUS_PRESET_MINUTES = [15, 25, 45, 60];

// Remaining milliseconds, clamped at 0 — never negative, even past the end.
export const remainingMs = (session, now = Date.now()) => {
  if (!session) return 0;
  return Math.max(0, session.startedAt + session.durationSec * 1000 - now);
};

// Remaining whole seconds, rounded up so the display reads 25:00 at
// the start of a 25-minute session instead of 24:59.
export const remainingSec = (session, now = Date.now()) =>
  Math.ceil(remainingMs(session, now) / 1000);

// Elapsed fraction 0..1, clamped — drives the ring's stroke-dashoffset.
export const focusProgress = (session, now = Date.now()) => {
  if (!session) return 0;
  const total = session.durationSec * 1000;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - session.startedAt) / total));
};

// True while the session still has time left. At exactly endsAt the
// session is over (the server's isExpired uses the same boundary).
export const isFocusActive = (session, now = Date.now()) =>
  !!session && remainingMs(session, now) > 0;

// "25:00" / "1:30" / "1:00:00" — hours only when the timer runs past
// an hour (max session is 2h). Minutes are never zero-padded ("5:00",
// not "05:00"); seconds always are.
export const formatFocusRemaining = (ms) => {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
};
