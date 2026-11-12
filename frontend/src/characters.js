// Animated character avatars (v0.7.0): 8 hand-crafted inline SVG
// characters, drawn with the same element-descriptor pattern as the
// hand-rolled icon set (iconPaths.js) — circles, ellipses, paths,
// rects, polygons and lines only, no new deps, no images to download.
//
// Pure ESM data + a string builder: characterSvg(id) returns the full
// `<svg>` markup, so the React component (CharacterAvatar.jsx) renders
// it and node tests can assert on it without a DOM. The string is built
// ONLY from these static constants — never from user input — so it is
// safe to inject via dangerouslySetInnerHTML.
//
// Each character is drawn on a 64x64 viewBox over a full-bleed circle
// filled with its own gradient (from AVATAR_CHARACTERS), so the art is
// already circular: it drops into the round .avatar span, the Profile
// picker and the round room orb without any clipping work. Animated
// parts carry classes (char-eyes, char-tail, char-light, char-glint,
// char-throat, char-mouth, char-twinkle); the looping motion lives in
// CharacterAvatar.css, keyed off the root `char-<id>` class.
import { AVATAR_CHARACTERS, avatarCharacterById } from './avatars.js';

// One character's art: an ordered list of SVG element descriptors.
// `class` marks an animated part; numeric attrs stay numbers.
const CHARACTER_ART = {
  // Foxy the fox — orange, bobs gently, blinks.
  'char-fox': [
    { el: 'polygon', points: '12,26 17,6 29,21', fill: '#c2410c' },
    { el: 'polygon', points: '52,26 47,6 35,21', fill: '#c2410c' },
    { el: 'polygon', points: '17,21 19,11 24,19', fill: '#fda4af' },
    { el: 'polygon', points: '47,21 45,11 40,19', fill: '#fda4af' },
    { el: 'circle', cx: 32, cy: 37, r: 17, fill: '#f97316' },
    { el: 'path', d: 'M26,23 Q32,16 38,23 Q32,20 26,23 Z', fill: '#c2410c' },
    { el: 'ellipse', class: 'char-eyes', cx: 25, cy: 33, rx: 2.2, ry: 3.2, fill: '#1f2937' },
    { el: 'ellipse', class: 'char-eyes', cx: 39, cy: 33, rx: 2.2, ry: 3.2, fill: '#1f2937' },
    { el: 'circle', cx: 19, cy: 42, r: 2.5, fill: '#fca5a5', opacity: 0.7 },
    { el: 'circle', cx: 45, cy: 42, r: 2.5, fill: '#fca5a5', opacity: 0.7 },
    { el: 'ellipse', cx: 32, cy: 44, rx: 9, ry: 6.5, fill: '#fff7ed' },
    { el: 'ellipse', cx: 32, cy: 41, rx: 3, ry: 2.2, fill: '#1f2937' }
  ],
  // Bolt the robot — slate + sky, antenna light pulses.
  'char-robot': [
    { el: 'line', x1: 32, y1: 11, x2: 32, y2: 18, stroke: '#94a3b8', 'stroke-width': 2.5 },
    { el: 'circle', class: 'char-light', cx: 32, cy: 9, r: 3, fill: '#facc15' },
    { el: 'rect', x: 8, y: 30, width: 4, height: 10, rx: 2, fill: '#38bdf8' },
    { el: 'rect', x: 52, y: 30, width: 4, height: 10, rx: 2, fill: '#38bdf8' },
    { el: 'rect', x: 14, y: 18, width: 36, height: 30, rx: 9, fill: '#e2e8f0' },
    { el: 'rect', x: 19, y: 23, width: 26, height: 20, rx: 6, fill: '#0f172a' },
    { el: 'circle', class: 'char-light', cx: 26, cy: 33, r: 3, fill: '#38bdf8' },
    { el: 'circle', class: 'char-light', cx: 38, cy: 33, r: 3, fill: '#38bdf8' },
    { el: 'rect', x: 26, y: 39, width: 12, height: 2.5, rx: 1.25, fill: '#38bdf8' },
    { el: 'rect', x: 27, y: 48, width: 10, height: 5, fill: '#94a3b8' }
  ],
  // Zorp the alien — green, floats, big blinking eyes.
  'char-alien': [
    { el: 'line', x1: 24, y1: 17, x2: 18, y2: 8, stroke: '#16a34a', 'stroke-width': 2 },
    { el: 'line', x1: 40, y1: 17, x2: 46, y2: 8, stroke: '#16a34a', 'stroke-width': 2 },
    { el: 'circle', class: 'char-light', cx: 18, cy: 7, r: 2.5, fill: '#a3e635' },
    { el: 'circle', class: 'char-light', cx: 46, cy: 7, r: 2.5, fill: '#a3e635' },
    { el: 'ellipse', cx: 32, cy: 37, rx: 17, ry: 19, fill: '#4ade80' },
    { el: 'circle', cx: 32, cy: 20, r: 2, fill: '#16a34a', opacity: 0.6 },
    { el: 'ellipse', class: 'char-eyes', cx: 24, cy: 34, rx: 4.5, ry: 6.5, fill: '#052e16', transform: 'rotate(-15 24 34)' },
    { el: 'ellipse', class: 'char-eyes', cx: 40, cy: 34, rx: 4.5, ry: 6.5, fill: '#052e16', transform: 'rotate(15 40 34)' },
    { el: 'circle', cx: 25.5, cy: 31.5, r: 1.2, fill: '#ffffff', opacity: 0.9 },
    { el: 'circle', cx: 41.5, cy: 31.5, r: 1.2, fill: '#ffffff', opacity: 0.9 },
    { el: 'circle', cx: 18, cy: 44, r: 2, fill: '#86efac', opacity: 0.8 },
    { el: 'circle', cx: 46, cy: 44, r: 2, fill: '#86efac', opacity: 0.8 },
    { el: 'ellipse', cx: 32, cy: 48, rx: 2.5, ry: 1.5, fill: '#052e16' }
  ],
  // Miso the cat — amber, tail sways, blinks.
  'char-cat': [
    { el: 'polygon', points: '13,27 16,8 28,20', fill: '#f59e0b' },
    { el: 'polygon', points: '51,27 48,8 36,20', fill: '#f59e0b' },
    { el: 'polygon', points: '17,21 18.5,12 24,18', fill: '#fda4af' },
    { el: 'polygon', points: '47,21 45.5,12 40,18', fill: '#fda4af' },
    { el: 'path', class: 'char-tail', d: 'M46,50 Q56,50 56,40 Q56,34 52,34', stroke: '#f59e0b', 'stroke-width': 4.5, fill: 'none', 'stroke-linecap': 'round' },
    { el: 'circle', cx: 32, cy: 37, r: 16, fill: '#fbbf24' },
    { el: 'line', x1: 27, y1: 24, x2: 29, y2: 29, stroke: '#d97706', 'stroke-width': 2, 'stroke-linecap': 'round' },
    { el: 'line', x1: 32, y1: 22, x2: 32, y2: 28, stroke: '#d97706', 'stroke-width': 2, 'stroke-linecap': 'round' },
    { el: 'line', x1: 37, y1: 24, x2: 35, y2: 29, stroke: '#d97706', 'stroke-width': 2, 'stroke-linecap': 'round' },
    { el: 'ellipse', class: 'char-eyes', cx: 25, cy: 36, rx: 2, ry: 3.2, fill: '#1f2937' },
    { el: 'ellipse', class: 'char-eyes', cx: 39, cy: 36, rx: 2, ry: 3.2, fill: '#1f2937' },
    { el: 'polygon', points: '29,43 35,43 32,46', fill: '#f472b6' },
    { el: 'path', d: 'M32,46 Q32,49 29,49 M32,46 Q32,49 35,49', stroke: '#92400e', 'stroke-width': 1.5, fill: 'none', 'stroke-linecap': 'round' },
    { el: 'line', x1: 10, y1: 38, x2: 20, y2: 40, stroke: '#fff7ed', 'stroke-width': 1.2, opacity: 0.8 },
    { el: 'line', x1: 10, y1: 44, x2: 20, y2: 42, stroke: '#fff7ed', 'stroke-width': 1.2, opacity: 0.8 },
    { el: 'line', x1: 54, y1: 38, x2: 44, y2: 40, stroke: '#fff7ed', 'stroke-width': 1.2, opacity: 0.8 },
    { el: 'line', x1: 54, y1: 44, x2: 44, y2: 42, stroke: '#fff7ed', 'stroke-width': 1.2, opacity: 0.8 }
  ],
  // Astro the astronaut — white helmet, visor glint twinkles, drifts.
  'char-astro': [
    { el: 'line', x1: 32, y1: 16, x2: 32, y2: 9, stroke: '#94a3b8', 'stroke-width': 2 },
    { el: 'circle', class: 'char-light', cx: 32, cy: 7, r: 2, fill: '#f87171' },
    { el: 'circle', cx: 32, cy: 34, r: 18, fill: '#f1f5f9' },
    { el: 'ellipse', cx: 32, cy: 34, rx: 12.5, ry: 11, fill: '#0284c7' },
    { el: 'ellipse', class: 'char-glint', cx: 27, cy: 29, rx: 4, ry: 2.5, fill: '#ffffff', opacity: 0.85, transform: 'rotate(-20 27 29)' },
    { el: 'circle', cx: 36, cy: 30, r: 1, fill: '#ffffff', opacity: 0.9 },
    { el: 'circle', cx: 39, cy: 36, r: 0.8, fill: '#ffffff', opacity: 0.9 },
    { el: 'circle', cx: 32, cy: 34, r: 18, fill: 'none', stroke: '#cbd5e1', 'stroke-width': 2 },
    { el: 'rect', x: 20, y: 50, width: 24, height: 10, rx: 4, fill: '#e2e8f0' },
    { el: 'circle', cx: 27, cy: 55, r: 1.5, fill: '#38bdf8' },
    { el: 'circle', cx: 32, cy: 55, r: 1.5, fill: '#facc15' },
    { el: 'circle', cx: 37, cy: 55, r: 1.5, fill: '#f87171' }
  ],
  // Bobo the panda — monochrome, bounces, blinks.
  'char-panda': [
    { el: 'circle', cx: 19, cy: 20, r: 5.5, fill: '#1f2937' },
    { el: 'circle', cx: 45, cy: 20, r: 5.5, fill: '#1f2937' },
    { el: 'circle', cx: 32, cy: 36, r: 17, fill: '#ffffff' },
    { el: 'ellipse', cx: 24, cy: 34, rx: 5, ry: 6.5, fill: '#1f2937', transform: 'rotate(-20 24 34)' },
    { el: 'ellipse', cx: 40, cy: 34, rx: 5, ry: 6.5, fill: '#1f2937', transform: 'rotate(20 40 34)' },
    { el: 'circle', class: 'char-eyes', cx: 25, cy: 33, r: 1.8, fill: '#ffffff' },
    { el: 'circle', class: 'char-eyes', cx: 39, cy: 33, r: 1.8, fill: '#ffffff' },
    { el: 'ellipse', cx: 32, cy: 42, rx: 3, ry: 2, fill: '#1f2937' },
    { el: 'path', d: 'M32,44 Q32,47 29,47 M32,44 Q32,47 35,47', stroke: '#1f2937', 'stroke-width': 1.5, fill: 'none', 'stroke-linecap': 'round' },
    { el: 'circle', cx: 19, cy: 43, r: 2.5, fill: '#fda4af', opacity: 0.6 },
    { el: 'circle', cx: 45, cy: 43, r: 2.5, fill: '#fda4af', opacity: 0.6 }
  ],
  // Hopper the frog — green, hops, throat pulses, blinks.
  'char-frog': [
    { el: 'circle', cx: 22, cy: 20, r: 6.5, fill: '#4ade80' },
    { el: 'circle', cx: 42, cy: 20, r: 6.5, fill: '#4ade80' },
    { el: 'circle', class: 'char-eyes', cx: 22, cy: 19, r: 3.5, fill: '#ffffff' },
    { el: 'circle', class: 'char-eyes', cx: 42, cy: 19, r: 3.5, fill: '#ffffff' },
    { el: 'circle', class: 'char-eyes', cx: 22, cy: 19, r: 1.8, fill: '#052e16' },
    { el: 'circle', class: 'char-eyes', cx: 42, cy: 19, r: 1.8, fill: '#052e16' },
    { el: 'ellipse', cx: 32, cy: 38, rx: 18, ry: 14, fill: '#4ade80' },
    { el: 'circle', cx: 28, cy: 36, r: 1, fill: '#14532d' },
    { el: 'circle', cx: 36, cy: 36, r: 1, fill: '#14532d' },
    { el: 'path', d: 'M22,40 Q32,48 42,40', stroke: '#052e16', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' },
    { el: 'ellipse', class: 'char-throat', cx: 32, cy: 50, rx: 7, ry: 3.5, fill: '#bbf7d0', opacity: 0.8 },
    { el: 'circle', cx: 16, cy: 40, r: 2.5, fill: '#86efac' },
    { el: 'circle', cx: 48, cy: 40, r: 2.5, fill: '#86efac' }
  ],
  // Boo the ghost — lavender, wobbles in the air, mouth pulses.
  'char-ghost': [
    { el: 'path', d: 'M14,56 V32 a18,18 0 0 1 36,0 V56 L44,51 L38,56 L32,51 L26,56 L20,51 Z', fill: '#e0e7ff' },
    { el: 'ellipse', class: 'char-eyes', cx: 25, cy: 32, rx: 2.8, ry: 4, fill: '#1e1b4b' },
    { el: 'ellipse', class: 'char-eyes', cx: 39, cy: 32, rx: 2.8, ry: 4, fill: '#1e1b4b' },
    { el: 'ellipse', class: 'char-mouth', cx: 32, cy: 42, rx: 3, ry: 4, fill: '#1e1b4b' },
    { el: 'circle', cx: 19, cy: 40, r: 2.5, fill: '#c7d2fe' },
    { el: 'circle', cx: 45, cy: 40, r: 2.5, fill: '#c7d2fe' },
    { el: 'circle', class: 'char-twinkle', cx: 50, cy: 20, r: 1.2, fill: '#ffffff' },
    { el: 'circle', class: 'char-twinkle', cx: 14, cy: 24, r: 1, fill: '#ffffff', opacity: 0.8 }
  ]
};

export const CHARACTER_IDS = AVATAR_CHARACTERS.map((c) => c.id);

export const characterArtById = (id) => CHARACTER_ART[id] || null;

// Metadata + art together, or null for an unknown id.
export const characterById = (id) => {
  const meta = avatarCharacterById(id);
  const parts = characterArtById(id);
  if (!meta || !parts) return null;
  return { ...meta, parts };
};

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeAttr = (v) => String(v).replace(/[&<>"]/g, (ch) => ESCAPES[ch]);

// Serialize one element descriptor to an SVG element string. Only the
// element names in KNOWN_ELEMENTS are emitted; anything else is dropped
// rather than rendered.
const KNOWN_ELEMENTS = new Set([
  'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'
]);

const renderEl = (el) => {
  if (!el || !KNOWN_ELEMENTS.has(el.el)) return '';
  const attrs = Object.entries(el)
    .filter(([k]) => k !== 'el')
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  return `<${el.el}${attrs}/>`;
};

// Full standalone SVG markup for a character id, or null for unknown
// ids. Includes a <title> + role/aria-label (the character's name) so
// screen readers get "Foxy the fox avatar" instead of silence.
export const characterSvg = (id) => {
  const character = characterById(id);
  if (!character) return null;
  const gradId = `char-grad-${id}`;
  const parts = character.parts.map(renderEl).join('');
  return (
    `<svg class="char char-${id}" data-char="${id}" viewBox="0 0 64 64" ` +
    `role="img" aria-label="${escapeAttr(character.name)} avatar" xmlns="http://www.w3.org/2000/svg">` +
    `<title>${escapeAttr(character.name)}</title>` +
    `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${character.from}"/>` +
    `<stop offset="1" stop-color="${character.to}"/></linearGradient></defs>` +
    `<circle cx="32" cy="32" r="32" fill="url(#${gradId})"/>` +
    parts +
    `</svg>`
  );
};
