// One hand-rolled line-icon set for the whole app — no icon package,
// so the PWA stays offline-friendly and the bundle stays small.
//
// Each icon is a list of SVG child elements (24×24 viewBox, stroke,
// currentColor) rendered by components/icons.jsx. Element descriptors:
//   { el: 'path', d } | { el: 'circle', cx, cy, r }
//   { el: 'ellipse', cx, cy, rx, ry, transform? }
//   { el: 'rect', x, y, width, height, rx? }
//   { el: 'line', x1, y1, x2, y2 }
//   { el: 'polyline' | 'polygon', points }
//
// To add an icon: add one entry here, then use <Icon name="…" />.
// Pure data (no React) so node --test can import it directly.
export const ICON_PATHS = {
  // Orbit wordmark / logo — a planet with a tilted ring.
  planet: [
    { el: 'circle', cx: 12, cy: 12, r: 5.5 },
    { el: 'ellipse', cx: 12, cy: 12, rx: 10, ry: 3.2, transform: 'rotate(-24 12 12)' }
  ],
  bell: [
    { el: 'path', d: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' },
    { el: 'path', d: 'M13.73 21a2 2 0 0 1-3.46 0' }
  ],
  mic: [
    { el: 'path', d: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z' },
    { el: 'path', d: 'M19 10v2a7 7 0 0 1-14 0v-2' },
    { el: 'line', x1: 12, y1: 19, x2: 12, y2: 23 },
    { el: 'line', x1: 8, y1: 23, x2: 16, y2: 23 }
  ],
  'mic-off': [
    { el: 'line', x1: 1, y1: 1, x2: 23, y2: 23 },
    { el: 'path', d: 'M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6' },
    { el: 'path', d: 'M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23' },
    { el: 'line', x1: 12, y1: 19, x2: 12, y2: 23 },
    { el: 'line', x1: 8, y1: 23, x2: 16, y2: 23 }
  ],
  headphones: [
    { el: 'path', d: 'M3 18v-6a9 9 0 0 1 18 0v6' },
    { el: 'path', d: 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z' }
  ],
  'headphones-off': [
    { el: 'path', d: 'M3 18v-6a9 9 0 0 1 18 0v6' },
    { el: 'path', d: 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z' },
    { el: 'line', x1: 2, y1: 2, x2: 22, y2: 22 }
  ],
  chat: [
    { el: 'path', d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' }
  ],
  // Together mode: a clock — circle + two hands, for the focus timer.
  timer: [
    { el: 'circle', cx: 12, cy: 12, r: 10 },
    { el: 'polyline', points: '12 6 12 12 16 14' }
  ],
  // Campfire (fading rooms): a flame, drawn as one stroke path.
  flame: [
    { el: 'path', d: 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z' }
  ],
  // Hang-up: the plain handset, rotated 135° by .voice-btn.leave CSS —
  // that rotation is what turns it into the familiar hang-up glyph.
  phone: [
    { el: 'path', d: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z' }
  ],
  users: [
    { el: 'path', d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' },
    { el: 'circle', cx: 9, cy: 7, r: 4 },
    { el: 'path', d: 'M23 21v-2a4 4 0 0 0-3-3.87' },
    { el: 'path', d: 'M16 3.13a4 4 0 0 1 0 7.75' }
  ],
  user: [
    { el: 'path', d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' },
    { el: 'circle', cx: 12, cy: 7, r: 4 }
  ],
  'user-plus': [
    { el: 'path', d: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' },
    { el: 'circle', cx: 9, cy: 7, r: 4 },
    { el: 'line', x1: 19, y1: 8, x2: 19, y2: 14 },
    { el: 'line', x1: 22, y1: 11, x2: 16, y2: 11 }
  ],
  search: [
    { el: 'circle', cx: 11, cy: 11, r: 8 },
    { el: 'line', x1: 21, y1: 21, x2: 16.65, y2: 16.65 }
  ],
  plus: [
    { el: 'line', x1: 12, y1: 5, x2: 12, y2: 19 },
    { el: 'line', x1: 5, y1: 12, x2: 19, y2: 12 }
  ],
  x: [
    { el: 'line', x1: 18, y1: 6, x2: 6, y2: 18 },
    { el: 'line', x1: 6, y1: 6, x2: 18, y2: 18 }
  ],
  check: [
    { el: 'polyline', points: '20 6 9 17 4 12' }
  ],
  'check-circle': [
    { el: 'path', d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' },
    { el: 'polyline', points: '22 4 12 14.01 9 11.01' }
  ],
  'chevron-left': [
    { el: 'polyline', points: '15 18 9 12 15 6' }
  ],
  // Chain link — invite links (RoomView header) and copy-link controls.
  link: [
    { el: 'path', d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' },
    { el: 'path', d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }
  ],
  send: [
    { el: 'line', x1: 22, y1: 2, x2: 11, y2: 13 },
    { el: 'polygon', points: '22 2 15 22 11 13 2 9 22 2' }
  ],
  lock: [
    { el: 'rect', x: 3, y: 11, width: 18, height: 11, rx: 2 },
    { el: 'path', d: 'M7 11V7a5 5 0 0 1 10 0v4' }
  ],
  // Knock: a door with two knock marks — asking to be let in.
  knock: [
    { el: 'rect', x: 8, y: 3, width: 11, height: 18, rx: 1 },
    { el: 'circle', cx: 16, cy: 12, r: 0.8 },
    { el: 'line', x1: 2, y1: 8, x2: 4.5, y2: 8 },
    { el: 'line', x1: 2, y1: 12, x2: 4.5, y2: 12 }
  ],
  globe: [
    { el: 'circle', cx: 12, cy: 12, r: 10 },
    { el: 'line', x1: 2, y1: 12, x2: 22, y2: 12 },
    { el: 'path', d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' }
  ],
  mail: [
    { el: 'rect', x: 2, y: 4, width: 20, height: 16, rx: 2 },
    { el: 'path', d: 'M22 6l-10 7L2 6' }
  ],
  crown: [
    { el: 'path', d: 'M3 8l4 3.5L12 5l5 6.5L21 8l-1.5 11h-15L3 8z' }
  ],
  shield: [
    { el: 'path', d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }
  ],
  image: [
    { el: 'rect', x: 3, y: 3, width: 18, height: 18, rx: 2 },
    { el: 'circle', cx: 8.5, cy: 8.5, r: 1.5 },
    { el: 'polyline', points: '21 15 16 10 5 21' }
  ],
  download: [
    { el: 'path', d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' },
    { el: 'polyline', points: '7 10 12 15 17 10' },
    { el: 'line', x1: 12, y1: 15, x2: 12, y2: 3 }
  ],
  volume: [
    { el: 'polygon', points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' },
    { el: 'path', d: 'M15.54 8.46a5 5 0 0 1 0 7.07' }
  ],
  home: [
    { el: 'path', d: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
    { el: 'polyline', points: '9 22 9 12 15 12 15 22' }
  ],
  settings: [
    { el: 'circle', cx: 12, cy: 12, r: 3 },
    { el: 'path', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' }
  ]
};

// Every icon the app renders. The test (tests/visualSystem.test.mjs)
// asserts this list is covered by ICON_PATHS, so adding a usage
// without an icon fails loudly instead of rendering nothing.
export const ICON_NAMES = Object.keys(ICON_PATHS);
