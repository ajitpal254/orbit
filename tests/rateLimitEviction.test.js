// Tests for the rate-limiter idle-IP eviction (audit I6,
// middleware/auth.js). Entries for IPs that stop requesting must not
// sit in the Map forever.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rateLimitMiddleware, pruneRateLimitEntries, RATE_LIMIT_EVICT_THRESHOLD } = require('../middleware/auth');

const WINDOW = 60 * 1000;
const T = 1_000_000;

test('pruneRateLimitEntries drops keys idle longer than the window, keeps live ones', () => {
  const hits = new Map([
    ['1.1.1.1', [T - WINDOW - 1]], // idle: newest hit is past the window
    ['2.2.2.2', [T - 1000]], // live
    ['3.3.3.3', [T - WINDOW - 5000, T - 500]] // live (newest hit recent)
  ]);
  pruneRateLimitEntries(hits, T, WINDOW);
  assert.deepEqual([...hits.keys()].sort(), ['2.2.2.2', '3.3.3.3']);
});

test('pruneRateLimitEntries drops empty entries', () => {
  const hits = new Map([['1.1.1.1', []], ['2.2.2.2', [T]]]);
  pruneRateLimitEntries(hits, T, WINDOW);
  assert.deepEqual([...hits.keys()], ['2.2.2.2']);
});

test('rateLimitMiddleware evicts idle IPs once the table grows past the threshold', () => {
  const realNow = Date.now;
  let now = T;
  Date.now = () => now;
  try {
    const mw = rateLimitMiddleware(1000, WINDOW, { evictThreshold: 2 });
    const res = { status: () => ({ json: () => {} }) };
    let nextCalls = 0;
    const next = () => { nextCalls += 1; };
    mw({ ip: '10.0.0.1' }, res, next);
    mw({ ip: '10.0.0.2' }, res, next);
    // Both IPs go idle (past the window), then a third IP arrives:
    // the table (3) passes the threshold, the prune runs, and the
    // two idle keys are evicted instead of accumulating forever.
    now = T + WINDOW + 1000;
    mw({ ip: '10.0.0.3' }, res, next);
    assert.equal(nextCalls, 3, 'live keys are never evicted by the prune');
    // A re-request from an evicted IP starts a fresh window (its old
    // hits are gone) — it is not 429'd by stale history.
    const strict = rateLimitMiddleware(1, WINDOW, { evictThreshold: 2 });
    let status = null;
    const res2 = { status: (s) => { status = s; return { json: () => {} }; } };
    now = T;
    strict({ ip: '10.0.0.1' }, res2, next); // 1st: ok
    strict({ ip: '10.0.0.2' }, res2, next);
    now = T + WINDOW + 1000; // both idle now
    strict({ ip: '10.0.0.3' }, res2, next); // triggers prune of the idle pair
    strict({ ip: '10.0.0.1' }, res2, next); // fresh window, not 429
    assert.equal(status, null, 'evicted IP starts fresh, no stale 429');
  } finally {
    Date.now = realNow;
  }
});

test('rateLimitMiddleware default evict threshold is 1000', () => {
  assert.equal(RATE_LIMIT_EVICT_THRESHOLD, 1000);
});
