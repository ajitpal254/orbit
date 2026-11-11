// Default ANIMATED avatar presets. No external images: each preset is
// a gradient + a motion variant, rendered by the shared Avatar component
// (frontend/src/components/Avatar.jsx) with pure CSS animations.
//
// The list lives here (backend, CommonJS) AND in frontend/src/avatars.js
// (ESM) — the two cannot share one module file across the CJS/ESM
// boundary, so tests/avatars.test.js asserts they stay identical.
// Keep them in sync: same ids, in the same order.
const AVATAR_PRESETS = [
  { id: 'nova', name: 'Nova', from: '#8b5cf6', to: '#d946ef', motion: 'pulse' },
  { id: 'aurora', name: 'Aurora', from: '#84cc16', to: '#34d399', motion: 'float' },
  { id: 'ember', name: 'Ember', from: '#f59e0b', to: '#f43f5e', motion: 'glow' },
  { id: 'tide', name: 'Tide', from: '#14b8a6', to: '#22d3ee', motion: 'shimmer' },
  { id: 'comet', name: 'Comet', from: '#0ea5e9', to: '#6366f1', motion: 'spin' },
  { id: 'bloom', name: 'Bloom', from: '#f43f5e', to: '#fb923c', motion: 'wave' },
  { id: 'sol', name: 'Sol', from: '#facc15', to: '#f97316', motion: 'twinkle' },
  { id: 'nebula', name: 'Nebula', from: '#6366f1', to: '#a855f7', motion: 'breathe' }
];

const AVATAR_PRESET_IDS = AVATAR_PRESETS.map((p) => p.id);

const avatarPresetById = (id) =>
  AVATAR_PRESETS.find((p) => p.id === id) || null;

const isValidAvatarPreset = (id) =>
  typeof id === 'string' && AVATAR_PRESET_IDS.includes(id);

module.exports = { AVATAR_PRESETS, AVATAR_PRESET_IDS, avatarPresetById, isValidAvatarPreset };
