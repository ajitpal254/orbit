// Per-socket token-bucket rate limits for socket.io events (audit M3).
// The REST API sits behind the global 120 req/min/IP limiter; the socket
// path bypassed it entirely, so one malicious or buggy client could flood
// chat (unbounded message creation), signal traffic, or presence churn.
//
// Pure + testable: no socket.io, no timers, no DB. The clock is injected
// (`now` defaults to Date.now) so unit tests can prove refill behaviour
// without waiting. One bucket per (socket, event); buckets start full so
// a fresh connection can burst, then refill at a steady rate.
//
// Limits (per socket, chosen so legitimate use never trips them):
//   chat-message: 10 burst, 1/s refill  — a human types a few messages
//     per 10s at most; 10 is headroom, not a target.
//   signal: 120 burst, 12/s refill     — a join into a full (~6-person)
//     room is the worst legitimate burst: offers + answers + ICE
//     candidates both ways, roughly 40-90 signals in the first seconds.
//     120 clears it with headroom; a flood (hundreds/sec) still drops.
//   mic-state / speaking: 5 burst, 5/s — both are change-only in the
//     client (mute toggles, speech start/stop), a few events per minute
//     in practice; 5/s is far above that and still stops a churn loop.
//   orb-move: 20 burst, 10/s refill — the client throttles drags to
//     ~10 Hz, so 10/s is the legitimate steady rate; the 20 burst
//     absorbs a drag start plus arrow-key repeats. A flood still drops.
//
// Excess events are dropped (return false); the caller logs the warning.
// `onLimited` fires at most once per 10s per (socket, event) so a flood
// does not turn into log spam.

const DEFAULT_LIMITS = {
  'chat-message': { capacity: 10, refillPerSecond: 1 },
  signal: { capacity: 120, refillPerSecond: 12 },
  'mic-state': { capacity: 5, refillPerSecond: 5 },
  speaking: { capacity: 5, refillPerSecond: 5 },
  'orb-move': { capacity: 20, refillPerSecond: 10 },
  // Together mode: starting/stopping a focus timer is a rare, deliberate
  // action — 5 burst, 1/s refill is far above legitimate use and still
  // stops a start/stop churn loop from spamming the room.
  'focus-start': { capacity: 5, refillPerSecond: 1 },
  'focus-stop': { capacity: 5, refillPerSecond: 1 },
  // Mood glow: a deliberate tap, a few times a minute at most — 5
  // burst, 1/s refill is far above legitimate use and stops a
  // mood-change churn loop from spamming the room.
  mood: { capacity: 5, refillPerSecond: 1 }
};

// Unknown events are not limited (fail open for events added later —
// the limiter must never silently break a new feature).
const WARN_THROTTLE_MS = 10_000;

const createSocketRateLimiter = (opts = {}) => {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const now = opts.now || Date.now;
  const onLimited = opts.onLimited || null;
  const buckets = new Map(); // `${socketId}:${event}` -> { tokens, updatedMs }
  const lastWarned = new Map(); // `${socketId}:${event}` -> ms

  // True when the event may proceed; false when it must be dropped.
  const allow = (socketId, event, atMs) => {
    const limit = limits[event];
    if (!limit) return true;
    const t = atMs ?? now();
    const key = `${socketId}:${event}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: limit.capacity, updatedMs: t };
      buckets.set(key, bucket);
    }
    // Refill for the time since the last check, capped at the burst size.
    const elapsedSec = Math.max(0, (t - bucket.updatedMs) / 1000);
    bucket.tokens = Math.min(
      limit.capacity,
      bucket.tokens + elapsedSec * limit.refillPerSecond
    );
    bucket.updatedMs = t;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    // Over the limit: drop, and warn at most once per window.
    if (onLimited) {
      const warnedAt = lastWarned.get(key);
      if (warnedAt === undefined || t - warnedAt >= WARN_THROTTLE_MS) {
        lastWarned.set(key, t);
        onLimited({ socketId, event });
      }
    }
    return false;
  };

  // A socket is gone: drop its buckets (and warn state) so the maps do
  // not grow forever. Called from the socket disconnect handler.
  const dropSocket = (socketId) => {
    const prefix = `${socketId}:`;
    for (const key of [...buckets.keys()]) {
      if (key.startsWith(prefix)) buckets.delete(key);
    }
    for (const key of [...lastWarned.keys()]) {
      if (key.startsWith(prefix)) lastWarned.delete(key);
    }
  };

  const clearAll = () => {
    buckets.clear();
    lastWarned.clear();
  };

  return { allow, dropSocket, clearAll, limits };
};

module.exports = { createSocketRateLimiter, DEFAULT_LIMITS };
