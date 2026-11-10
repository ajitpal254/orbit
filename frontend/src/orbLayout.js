// Deterministic orb layout: given the people in a room, scatter them in a
// loose circle so the view feels spatial, not grid-like. Pure function —
// same people, same layout, so orbs never jump on re-render.
//
// Returns [{ id, x, y, size, delay, duration }] with x/y as % of the
// container. Pure + testable without a browser.

const hashString = (str = '') => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export function orbPositions(people) {
  const n = people.length;
  if (n === 0) return [];
  if (n === 1) {
    return [{ id: people[0].id, x: 50, y: 46, size: 118, delay: 0, duration: 7 }];
  }
  // Golden-angle spiral: even spread, organic feel.
  return people.map((p, i) => {
    const h = hashString(p.id);
    const angle = i * 2.39996 + (h % 100) / 100; // golden angle + jitter
    const ring = 26 + (h % 13); // radius 26–38% of container
    const x = 50 + Math.cos(angle) * ring * 1.15;
    const y = 46 + Math.sin(angle) * ring * 0.82;
    return {
      id: p.id,
      x: Math.round(Math.min(88, Math.max(12, x)) * 10) / 10,
      y: Math.round(Math.min(84, Math.max(14, y)) * 10) / 10,
      size: 76 + (h % 36), // 76–112px
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
