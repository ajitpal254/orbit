// Pure room helpers: validation, accents, initials, deterministic hashing.
// No DB access here so these are unit-testable without MongoDB.

// Room accent palette — each room picks one; orbs and cards glow in it.
const ACCENTS = [
  { id: 'violet', name: 'Nebula', from: '#8b5cf6', to: '#d946ef' },
  { id: 'teal', name: 'Lagoon', from: '#14b8a6', to: '#22d3ee' },
  { id: 'amber', name: 'Ember', from: '#f59e0b', to: '#f43f5e' },
  { id: 'lime', name: 'Aurora', from: '#84cc16', to: '#34d399' },
  { id: 'sky', name: 'Comet', from: '#0ea5e9', to: '#6366f1' },
  { id: 'rose', name: 'Sunset', from: '#f43f5e', to: '#fb923c' }
];

const accentById = (id) => ACCENTS.find((a) => a.id === id) || ACCENTS[0];

// Validate + sanitize room creation input. Returns { ok, error?, room? }.
const validateRoomInput = (body = {}) => {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  const accent = accentById(body.accent).id;
  // Only an explicit true makes a room private — anything else is public,
  // so old clients and old rooms stay public by default.
  const isPrivate = body.isPrivate === true;
  // Together mode: only an explicit 'focus' makes a focus room; anything
  // else (including old clients sending nothing) is a talk room.
  const mode = body.mode === 'focus' ? 'focus' : 'talk';
  // Same for campfires: only an explicit true makes a room ephemeral.
  // Old clients send nothing and get a permanent room; the create form
  // defaults its Campfire toggle on (playbook: "temporary by default").
  const ephemeral = body.ephemeral === true;
  if (!name) return { ok: false, error: 'Room name required' };
  if (name.length > 60) return { ok: false, error: 'Room name too long (max 60)' };
  if (topic.length > 140) return { ok: false, error: 'Topic too long (max 140)' };
  return { ok: true, room: { name: name.slice(0, 60), topic: topic.slice(0, 140), accent, isPrivate, ephemeral, mode } };
};

// "Ajit Pal" -> "AP"; "ajit" -> "AJ"; "" -> "?"
const initials = (name = '') => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// Small deterministic string hash (FNV-1a) — drives orb hue/position jitter
// so a person always looks the same across renders.
const hashString = (str = '') => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

// Validate a chat message body. Returns { ok, error?, text? }.
const validateMessageInput = (body = {}) => {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { ok: false, error: 'Message is empty' };
  if (text.length > 1000) return { ok: false, error: 'Message too long (max 1000)' };
  return { ok: true, text: text.slice(0, 1000) };
};

module.exports = { ACCENTS, accentById, validateRoomInput, initials, hashString, validateMessageInput };
