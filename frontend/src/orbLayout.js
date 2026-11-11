// Deterministic orb layout: given the people in a room, scatter them in a
// loose circle so the view feels spatial, not grid-like. Pure function —
// same people, same layout, so orbs never jump on re-render.
//
// Returns [{ id, x, y, size, delay, duration }] with x/y as % of the
// container. Pure + testable without a browser.
//
// `container` ({ width, height } in px) is optional. When given, every
// orb is clamped in px so center ± radius — plus room for the name label
// under the orb — stays inside the container. Without it, the old %-only
// clamp applies, which assumes a roomy desktop container and can clip a
// wide orb on a narrow phone (a 112px orb centered at x=12% of a 360px
// room sticks 13px past the left edge).
const hashString = (str = '') => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

function clampOrb(x, y, size, container) {
  if (!container || !(container.width > 0) || !(container.height > 0)) {
    return {
      x: Math.min(88, Math.max(12, x)),
      y: Math.min(84, Math.max(14, y)),
      size
    };
  }
  const W = container.width;
  const H = container.height;
  // Shrink first: if the room is so small the orb could never fit, a
  // smaller orb beats a clipped one.
  const capped = Math.min(size, Math.max(56, Math.floor(Math.min(W, H) * 0.4)));
  const r = capped / 2;
  const m = 6; // breathing room from the edge, px
  const label = 28; // name / "muted by moderator" label hangs below the orb
  const minX = Math.min(r + m, W / 2);
  const maxX = Math.max(W - r - m, W / 2);
  const minY = Math.min(r + m, H / 2);
  const maxY = Math.max(H - r - m - label, H / 2);
  const cx = Math.min(Math.max((x / 100) * W, minX), maxX);
  const cy = Math.min(Math.max((y / 100) * H, minY), maxY);
  return { x: (cx / W) * 100, y: (cy / H) * 100, size: capped };
}

export function orbPositions(people, container) {
  const n = people.length;
  if (n === 0) return [];
  // On a big desktop room the 76–112px orbs would look lost, so sizes
  // scale with the container (up to 1.5×). Phones (min side ≤ 480px)
  // keep scale 1, so the existing phone sizes are untouched; without a
  // container there is nothing to scale against, so scale is 1 too.
  const sizeScale =
    container && container.width > 0 && container.height > 0
      ? Math.min(1.5, Math.max(1, Math.min(container.width, container.height) / 480))
      : 1;
  // People are keyed by socketId in the room view (they have no `id`
  // field); fall back to `id` for callers that use it (tests, home screen).
  const pid = (p) => p.socketId || p.id;
  if (n === 1) {
    const c = clampOrb(50, 46, Math.round(118 * sizeScale), container);
    return [{ id: pid(people[0]), x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, size: c.size, delay: 0, duration: 7 }];
  }
  // Golden-angle spiral: even spread, organic feel.
  return people.map((p, i) => {
    const h = hashString(pid(p));
    const angle = i * 2.39996 + (h % 100) / 100; // golden angle + jitter
    const ring = 26 + (h % 13); // radius 26–38% of container
    const x = 50 + Math.cos(angle) * ring * 1.15;
    const y = 46 + Math.sin(angle) * ring * 0.82;
    const c = clampOrb(x, y, Math.round((76 + (h % 36)) * sizeScale), container); // size 76–112px on phones, up to 1.5× on desktop
    return {
      id: pid(p),
      x: Math.round(c.x * 10) / 10,
      y: Math.round(c.y * 10) / 10,
      size: c.size,
      delay: -((h % 50) / 10),
      duration: 6 + (h % 40) / 10 // 6–10s float cycle
    };
  });
}

export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Per-person hue shift so orbs in the same room still feel distinct.
export function orbHue(id) {
  return hashString(id) % 360;
}
