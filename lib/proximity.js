// Server-side position validation for orb-move (v0.6.0).
// Never trust arbitrary client coordinates: a client may send any
// JSON, so positions are validated (finite numbers only) and clamped
// to the room ([0, 100] on both axes) before anything is relayed.
// Coordinates are never logged — see lib/socket.js (the relay emits
// only the clamped position to room members).
// Pure + testable: no socket.io, no DB.
const MIN_COORD = 0;
const MAX_COORD = 100;

const clampCoord = (v) => Math.min(MAX_COORD, Math.max(MIN_COORD, v));

// Strict: x/y must be finite numbers. Strings, null, NaN, Infinity
// and missing fields are rejected ({ ok: false }) — the move is
// dropped, not coerced, so a buggy or hostile client cannot smuggle
// a value through Number() coercion.
const validatePosition = (pos = {}) => {
  if (!pos || typeof pos !== 'object') return { ok: false, x: null, y: null };
  const { x, y } = pos;
  if (typeof x !== 'number' || typeof y !== 'number') return { ok: false, x: null, y: null };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, x: null, y: null };
  return { ok: true, x: clampCoord(x), y: clampCoord(y) };
};

module.exports = { validatePosition, MIN_COORD, MAX_COORD };
