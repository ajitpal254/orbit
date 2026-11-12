// Proximity audio + huddles — pure logic (v0.6.0).
//
// Positions are percentages of the room stage (x, y in [0, 100]),
// the same coordinate space orbLayout.js already uses. Distance is
// therefore also in "% of the room" units: two orbs on opposite sides
// of a wide room are ~100 apart, diagonally up to ~141.
//
// ── Distance → volume curve (documented, deliberate) ──────────────
//   distance d        gain
//   ─────────────────────────────
//   d <= 25           1.00  (close: full volume — "standing next to you")
//   25 < d < 90       linear falloff from 1.00 down to 0.15
//   d >= 90           0.15  (far: quiet, never silent)
//
//   gain(d) = 1 - (d - 25) / (90 - 25) * (1 - 0.15)   in the falloff band
//   e.g. d = 50 → ~0.67, d = 70 → ~0.41, d = 90 → 0.15.
//
//   AUDIBLE_RADIUS = 90 is the distance at which the falloff bottoms
//   out. There is no hard cutoff: beyond the audible radius a voice
//   stays at the 0.15 floor. The floor is deliberate — a distant friend
//   never goes fully silent, so nobody vanishes from the room without
//   leaving it, and a far-away speaker is still faintly audible if
//   they call your name.
//
// ── Hysteresis ────────────────────────────────────────────────────
//   gainForDistance takes the previous gain: a recomputed gain within
//   HYSTERESIS_GAIN (0.05) of the previous one is ignored, so small
//   orb wobbles and drag jitter do not make the volume flicker.
//   clusterHuddles takes the previous huddles: a pair that was in a
//   huddle together stays clustered until it drifts past
//   HUDDLE_THRESHOLD + HUDDLE_HYSTERESIS, so a bubble does not pop
//   in and out while two orbs hover near the boundary.
//
// ── Kill switch ───────────────────────────────────────────────────
//   SPATIAL_AUDIO_ENABLED = false restores flat voice for everyone:
//   every remote stream plays at gain 1 and no distance math runs
//   (voice.js checks the flag; RoomView's toggle calls
//   engine.setSpatialEnabled, which is the same switch at runtime).
//   Huddle bubbles are visual only and keep rendering — they describe
//   where orbs are, not how loud they sound.
//
// ── Fallback ──────────────────────────────────────────────────────
//   A peer with no position data (never moved, old client, or a join
//   before any orb-move arrived) hears / is heard at full gain —
//   voice.js treats a missing position as gain 1, never as silence.
//   If building the AudioContext gain chain throws, voice.js marks
//   spatial audio failed and leaves the <audio> element playing flat.
export const SPATIAL_AUDIO_ENABLED = true;

// Full volume inside this distance (% of room width/height).
export const FULL_GAIN_RADIUS = 25;
// Distance at which the falloff reaches the floor (% of room).
export const AUDIBLE_RADIUS = 90;
// Quietest a remote voice ever gets — never 0 (see header).
export const MIN_GAIN = 0.15;
// Huddle: orbs closer than this (% of room) cluster into a bubble.
export const HUDDLE_THRESHOLD = 30;
// Extra slack before a huddle breaks apart (hysteresis, % of room).
export const HUDDLE_HYSTERESIS = 5;
// Gain changes smaller than this are ignored (hysteresis).
export const HYSTERESIS_GAIN = 0.05;

export const distanceBetween = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};

// Gain for a distance d (see the curve in the header). `prevGain` is
// the gain currently applied; when given, changes smaller than
// HYSTERESIS_GAIN are swallowed so the volume does not flicker while
// an orb drifts near a boundary. Non-finite distances (missing data)
// mean "no position" — full gain, never silence.
export function gainForDistance(d, prevGain = null) {
  let gain;
  if (!Number.isFinite(d) || d <= FULL_GAIN_RADIUS) {
    gain = 1;
  } else if (d >= AUDIBLE_RADIUS) {
    gain = MIN_GAIN;
  } else {
    gain = 1 - ((d - FULL_GAIN_RADIUS) / (AUDIBLE_RADIUS - FULL_GAIN_RADIUS)) * (1 - MIN_GAIN);
  }
  if (prevGain !== null && Number.isFinite(prevGain) && Math.abs(gain - prevGain) < HYSTERESIS_GAIN) {
    return prevGain;
  }
  return gain;
}

// Clamp a position into the room ([0, 100] on both axes). Non-finite
// input falls back to the centre (50, 50) — a drag or keypress must
// never park an orb off-stage. Mirrors lib/proximity.js on the
// server, which additionally rejects non-numeric input outright.
export function clampPosition(x, y) {
  const cx = Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : 50;
  const cy = Number.isFinite(y) ? Math.min(100, Math.max(0, y)) : 50;
  return { x: cx, y: cy };
}

// Group orbs into huddles: connected components of the graph where an
// edge means "closer than HUDDLE_THRESHOLD" (a chain A–B–C clusters
// even if A and C are far apart). Singletons are not huddles and are
// dropped. `prevHuddles` (the previous return value) adds hysteresis:
// a pair that shared a huddle stays linked up to
// HUDDLE_THRESHOLD + HUDDLE_HYSTERESIS.
//
// Returns [{ ids, cx, cy, radius }] — centroid + bubble radius in %
// units (farthest member from the centroid, plus an orb-radius margin
// so the bubble wraps the orbs instead of cutting through them).
export function clusterHuddles(positions, prevHuddles = []) {
  const points = (positions || []).filter(
    (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)
  );
  if (points.length < 2) return [];
  const prevTogether = new Set();
  for (const h of prevHuddles || []) {
    const ids = h.ids || [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        prevTogether.add(`${ids[i]}|${ids[j]}`);
        prevTogether.add(`${ids[j]}|${ids[i]}`);
      }
    }
  }
  // Union-find over the points.
  const parent = points.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = distanceBetween(points[i], points[j]);
      const wasTogether = prevTogether.has(`${points[i].id}|${points[j].id}`);
      const threshold = wasTogether ? HUDDLE_THRESHOLD + HUDDLE_HYSTERESIS : HUDDLE_THRESHOLD;
      if (d < threshold) union(i, j);
    }
  }
  const groups = new Map();
  points.forEach((p, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  });
  const huddles = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue; // singletons are not huddles
    const cx = members.reduce((s, p) => s + p.x, 0) / members.length;
    const cy = members.reduce((s, p) => s + p.y, 0) / members.length;
    const radius =
      Math.max(...members.map((p) => distanceBetween(p, { x: cx, y: cy }))) + 16;
    huddles.push({ ids: members.map((p) => p.id), cx, cy, radius });
  }
  return huddles;
}
