// Default ANIMATED avatar presets (frontend copy). No external images:
// each preset is a gradient + a motion variant, rendered by the shared
// Avatar component with pure CSS animations.
//
// MUST stay identical to lib/avatars.js (backend, CommonJS) — the two
// cannot share one module file across the CJS/ESM boundary, so
// tests/avatars.test.js asserts the lists match. Keep them in sync:
// same ids, in the same order.
export const AVATAR_PRESETS = [
  { id: 'nova', name: 'Nova', from: '#8b5cf6', to: '#d946ef', motion: 'pulse' },
  { id: 'aurora', name: 'Aurora', from: '#84cc16', to: '#34d399', motion: 'float' },
  { id: 'ember', name: 'Ember', from: '#f59e0b', to: '#f43f5e', motion: 'glow' },
  { id: 'tide', name: 'Tide', from: '#14b8a6', to: '#22d3ee', motion: 'shimmer' },
  { id: 'comet', name: 'Comet', from: '#0ea5e9', to: '#6366f1', motion: 'spin' },
  { id: 'bloom', name: 'Bloom', from: '#f43f5e', to: '#fb923c', motion: 'wave' },
  { id: 'sol', name: 'Sol', from: '#facc15', to: '#f97316', motion: 'twinkle' },
  { id: 'nebula', name: 'Nebula', from: '#6366f1', to: '#a855f7', motion: 'breathe' }
];

export const AVATAR_PRESET_IDS = AVATAR_PRESETS.map((p) => p.id);

export const avatarPresetById = (id) =>
  AVATAR_PRESETS.find((p) => p.id === id) || null;

// Animated CHARACTER avatars (v0.7.0) — frontend copy of the backend
// list in lib/avatars.js. Same storage as the gradient presets: one
// string field, `avatarPreset`, on the user — a character id is a preset
// id with a `char-` prefix, so the type is encoded in the key itself
// (no schema change, no migration). The hand-drawn SVG art for each
// character lives in ./characters.js; this list is only the metadata
// (id, name, backdrop gradient, looping motion) shared with the server
// for validation. Keep identical to lib/avatars.js.
export const AVATAR_CHARACTERS = [
  { id: 'char-fox', name: 'Foxy', from: '#f97316', to: '#ef4444', motion: 'bob' },
  { id: 'char-robot', name: 'Bolt', from: '#64748b', to: '#38bdf8', motion: 'glow' },
  { id: 'char-alien', name: 'Zorp', from: '#22c55e', to: '#a3e635', motion: 'float' },
  { id: 'char-cat', name: 'Miso', from: '#f59e0b', to: '#fbbf24', motion: 'sway' },
  { id: 'char-astro', name: 'Astro', from: '#e2e8f0', to: '#94a3b8', motion: 'drift' },
  { id: 'char-panda', name: 'Bobo', from: '#f8fafc', to: '#94a3b8', motion: 'bounce' },
  { id: 'char-frog', name: 'Hopper', from: '#4ade80', to: '#16a34a', motion: 'hop' },
  { id: 'char-ghost', name: 'Boo', from: '#e0e7ff', to: '#a5b4fc', motion: 'wobble' }
];

export const AVATAR_CHARACTER_IDS = AVATAR_CHARACTERS.map((c) => c.id);

export const avatarCharacterById = (id) =>
  AVATAR_CHARACTERS.find((c) => c.id === id) || null;

export const isAvatarCharacter = (id) =>
  typeof id === 'string' && AVATAR_CHARACTER_IDS.includes(id);

// A preset id is valid if it names a gradient preset OR a character.
// Gradient ids are unchanged, so every existing user's avatar keeps
// resolving exactly as before.
export const isValidAvatarPreset = (id) =>
  typeof id === 'string' &&
  (AVATAR_PRESET_IDS.includes(id) || AVATAR_CHARACTER_IDS.includes(id));
