// Night-sky home: pure helpers for frontend/src/components/NightSky.jsx.
// Friends become stars on a night sky, positioned deterministically from
// a hash of the friend's user id (same FNV-1a hashString as orbLayout.js),
// so a star never jumps when presence refreshes. No fetching here —
// callers pass the GET /api/friends/presence rows (the same data path
// SidePanel.jsx uses). Pure + browser-free, unit-tested in
// tests/nightSky.test.mjs.
//
// Presence states (playbook + addendum):
//   in-room — bright, glowing + pulsing (tap joins their room)
//   online  — bright, steady glow
//   away    — amber
//   offline — dim (small, grey; includes unknown/missing status, so a
//             friend the server knows nothing about never looks live)
import { hashString } from './orbLayout.js';

export const STAR_STATES = ['in-room', 'online', 'away', 'offline'];

// How many stars the sky shows before the rest collapse into a
// "+N more" link to the Friends tab — past this the positions crowd.
export const MAX_STARS = 12;

// Presence → star state. An "in-room" row with no room to join is a
// stale/partial row, so it falls back to plain "online" rather than
// offering a join that would fail. Anything unrecognised (including a
// missing friend object) is "offline": never imply someone is live
// on data we don't have.
export function starState(friend) {
  const status = friend?.status;
  if (status === 'in-room') return friend?.room?.id ? 'in-room' : 'online';
  if (status === 'online') return 'online';
  if (status === 'away') return 'away';
  return 'offline';
}

export function canJoin(friend) {
  return starState(friend) === 'in-room';
}

// Deterministic star position: golden-angle spiral (same idea as
// orbPositions) scaled into the sky box, with size / twinkle jitter
// from the id hash. Same id → same spot, size and twinkle, forever.
// x/y are % of the sky stage; size is the star dot in px.
export function starPosition(friend, index = 0) {
  const id = String(friend?.id ?? friend ?? '');
  const h = hashString(id);
  const angle = index * 2.39996 + (h % 100) / 100; // golden angle + jitter
  const ring = 24 + (h % 15); // radius 24–38% of the stage
  const x = 50 + Math.cos(angle) * ring * 1.35;
  const y = 48 + Math.sin(angle) * ring * 0.85;
  return {
    x: Math.round(Math.min(92, Math.max(8, x)) * 10) / 10,
    y: Math.round(Math.min(86, Math.max(14, y)) * 10) / 10,
    size: 26 + (h % 18), // 26–43px dot
    delay: -((h % 50) / 10),
    duration: 2.4 + (h % 30) / 10 // 2.4–5.3s twinkle cycle
  };
}

// Short status line under the star's name — the non-colour cue, so
// presence is never carried by colour alone.
export function starStatusText(friend) {
  const state = starState(friend);
  if (state === 'in-room') return `In ${friend.room?.name || 'a room'}`;
  if (state === 'online') return 'Online';
  if (state === 'away') return 'Away';
  return 'Offline';
}

// Screen-reader / tooltip label for a star button.
export function starLabel(friend) {
  const name = friend?.name || 'Friend';
  const state = starState(friend);
  if (state === 'in-room') {
    return `${name} — in ${friend.room?.name || 'a room'}. Tap to join.`;
  }
  if (state === 'online') return `${name} — online. Tap for details.`;
  if (state === 'away') return `${name} — away. Tap for details.`;
  return `${name} — offline. Tap for details.`;
}

// "N friends are out tonight" — in a room or online counts as out.
export function outCount(friends) {
  return (friends || []).filter(
    (f) => starState(f) === 'in-room' || starState(f) === 'online'
  ).length;
}

const STATE_ORDER = { 'in-room': 0, online: 1, away: 2, offline: 3 };

// The stars the sky renders, in-room first (then online, away,
// offline; name within each group — the same order the presence
// endpoint already returns, re-applied defensively), capped at
// MAX_STARS. `overflow` is how many friends the "+N more" link
// stands for (0 when everyone fits).
export function visibleStars(friends) {
  const sorted = [...(friends || [])].sort(
    (a, b) =>
      STATE_ORDER[starState(a)] - STATE_ORDER[starState(b)] ||
      String(a?.name || '').localeCompare(String(b?.name || ''))
  );
  const stars = sorted.slice(0, MAX_STARS);
  return { stars, overflow: Math.max(0, sorted.length - stars.length) };
}
