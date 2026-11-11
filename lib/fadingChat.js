// Fading chat: room messages and DMs expire 24h after they are written.
//
// Rules (playbook + addendum):
// - `expireAt` is a plain BSON Date, set server-side on write to
//   createdAt + 24h. It is NEVER encrypted (only `text` is) and NEVER
//   taken from a client-supplied value — withExpiry() overwrites it.
// - Mongo's TTL index is async background storage cleanup ONLY. Expiry
//   is enforced in application queries at READ time via
//   notExpiredFilter(): a message whose expireAt is at or before now
//   stops appearing immediately, without waiting for the TTL monitor.
// - Legacy messages with no expireAt stay visible (grandfathered — no
//   backfill: silently deleting pre-existing history on deploy would
//   be a surprise). Edits/replies/reactions do not extend lifetime
//   (there is no edit path; if one is added it must not touch expireAt).
// - No client-side deletion timers and no countdown UI: expired
//   messages simply stop appearing.
//
// Pure helpers here so they are unit-testable without MongoDB; the
// routes use them for both the write stamp and the read filter.

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Server-side expiry for a message written at `createdAt`.
const expiryFor = (createdAt = new Date()) =>
  new Date(new Date(createdAt).getTime() + MESSAGE_TTL_MS);

// Expired when expireAt is at or before `now`. A message with no
// expireAt (legacy, pre-fading-chat) is never expired.
const isExpired = (message, now = new Date()) => {
  if (!message || message.expireAt == null) return false;
  return new Date(message.expireAt).getTime() <= new Date(now).getTime();
};

const isVisible = (message, now = new Date()) => !isExpired(message, now);

// In-memory equivalent of notExpiredFilter(), for rows already fetched
// (e.g. the DM summary helpers in lib/dms.js).
const visibleMessages = (messages = [], now = new Date()) =>
  messages.filter((m) => isVisible(m, now));

// Mongo read-time filter: only messages still alive at `now`.
// `{ expireAt: null }` matches docs where the field is missing OR null,
// so legacy messages stay visible; `{ $gt: now }` keeps unexpired ones.
// Spread into a find filter, or combine with $and when the base query
// already has its own $or (DM thread / DM list).
const notExpiredFilter = (now = new Date()) => ({
  $or: [{ expireAt: null }, { expireAt: { $gt: new Date(now) } }]
});

// Stamp server-side expiry onto a message document's fields at write
// time. Any client-supplied expireAt in `fields` is overwritten —
// the server clock is the only authority.
const withExpiry = (fields, now = new Date()) => ({
  ...fields,
  expireAt: expiryFor(now)
});

module.exports = {
  MESSAGE_TTL_MS,
  expiryFor,
  isExpired,
  isVisible,
  visibleMessages,
  notExpiredFilter,
  withExpiry
};
