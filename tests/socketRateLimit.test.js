// Tests for the per-socket token-bucket limiter (lib/socketRateLimit.js,
// audit M3). The clock is injected, so refill behaviour is proven without
// waiting. No socket.io, no MongoDB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSocketRateLimiter, DEFAULT_LIMITS } = require('../lib/socketRateLimit');

test('chat-message: burst of 10 allowed, 11th dropped, refills 1/s', () => {
  let now = 0;
  const limiter = createSocketRateLimiter({ now: () => now });
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.allow('sock-a', 'chat-message'), true, `message ${i + 1} allowed`);
  }
  assert.equal(limiter.allow('sock-a', 'chat-message'), false, '11th message in the burst drops');
  // Half a second of refill is not a whole token.
  now += 500;
  assert.equal(limiter.allow('sock-a', 'chat-message'), false);
  // One full second refills exactly one token.
  now += 500;
  assert.equal(limiter.allow('sock-a', 'chat-message'), true);
  assert.equal(limiter.allow('sock-a', 'chat-message'), false);
  // Ten seconds of idle refills the whole bucket (capped at capacity).
  now += 10_000;
  for (let i = 0; i < 10; i++) assert.equal(limiter.allow('sock-a', 'chat-message'), true);
  assert.equal(limiter.allow('sock-a', 'chat-message'), false);
});

test('signal: 120-burst covers a full-room join storm, then drops', () => {
  let now = 0;
  const limiter = createSocketRateLimiter({ now: () => now });
  // Worst legitimate burst: joining a 6-person room — offers, answers and
  // ICE candidates both ways — is roughly 40-90 signals in seconds.
  for (let i = 0; i < 90; i++) {
    assert.equal(limiter.allow('sock-a', 'signal'), true, `signal ${i + 1} allowed`);
  }
  for (let i = 0; i < 30; i++) assert.equal(limiter.allow('sock-a', 'signal'), true);
  assert.equal(limiter.allow('sock-a', 'signal'), false, '121st signal in the burst drops');
  // Refill is 12/s: after 1s, 12 more get through.
  now += 1000;
  for (let i = 0; i < 12; i++) assert.equal(limiter.allow('sock-a', 'signal'), true);
  assert.equal(limiter.allow('sock-a', 'signal'), false);
});

test('mic-state / speaking: a few per second, then dropped', () => {
  let now = 0;
  const limiter = createSocketRateLimiter({ now: () => now });
  for (const event of ['mic-state', 'speaking']) {
    for (let i = 0; i < 5; i++) assert.equal(limiter.allow('sock-a', event), true);
    assert.equal(limiter.allow('sock-a', event), false, `${event}: 6th in the burst drops`);
    now += 1000;
    for (let i = 0; i < 5; i++) assert.equal(limiter.allow('sock-a', event), true);
  }
});

test('buckets are independent per socket and per event', () => {
  let now = 0;
  const limiter = createSocketRateLimiter({ now: () => now });
  for (let i = 0; i < 10; i++) assert.equal(limiter.allow('sock-a', 'chat-message'), true);
  assert.equal(limiter.allow('sock-a', 'chat-message'), false);
  // Another socket is unaffected, and so is another event on the same socket.
  assert.equal(limiter.allow('sock-b', 'chat-message'), true);
  assert.equal(limiter.allow('sock-a', 'signal'), true);
});

test('unknown events are not limited (fail open for future events)', () => {
  const limiter = createSocketRateLimiter({ now: () => 0 });
  for (let i = 0; i < 500; i++) assert.equal(limiter.allow('sock-a', 'some-future-event'), true);
});

test('onLimited fires once per 10s per socket+event, not per drop', () => {
  let now = 0;
  const warned = [];
  const limiter = createSocketRateLimiter({
    now: () => now,
    onLimited: ({ socketId, event }) => warned.push([socketId, event])
  });
  for (let i = 0; i < 10; i++) limiter.allow('sock-a', 'chat-message');
  limiter.allow('sock-a', 'chat-message'); // drop 1 -> warn
  limiter.allow('sock-a', 'chat-message'); // drop 2 -> throttled, no warn
  limiter.allow('sock-a', 'chat-message'); // drop 3 -> throttled, no warn
  assert.deepEqual(warned, [['sock-a', 'chat-message']]);
  now += 9999;
  limiter.allow('sock-a', 'chat-message'); // allowed (9.999 tokens refilled), still no warn
  assert.equal(warned.length, 1);
  now += 1; // window elapsed — but the bucket also refilled, so drain it first
  for (let i = 0; i < 10; i++) limiter.allow('sock-a', 'chat-message');
  limiter.allow('sock-a', 'chat-message'); // drop -> warn again
  assert.equal(warned.length, 2);
});

test('dropSocket frees the bucket so a reconnect starts full', () => {
  let now = 0;
  const limiter = createSocketRateLimiter({ now: () => now });
  for (let i = 0; i < 10; i++) limiter.allow('sock-a', 'chat-message');
  assert.equal(limiter.allow('sock-a', 'chat-message'), false);
  limiter.dropSocket('sock-a');
  for (let i = 0; i < 10; i++) assert.equal(limiter.allow('sock-a', 'chat-message'), true);
  assert.equal(limiter.allow('sock-a', 'chat-message'), false);
  // Dropping one socket leaves the other's bucket alone.
  limiter.dropSocket('sock-a');
  assert.equal(limiter.allow('sock-b', 'chat-message'), true);
});

test('default limits are the documented numbers', () => {
  assert.deepEqual(DEFAULT_LIMITS['chat-message'], { capacity: 10, refillPerSecond: 1 });
  assert.deepEqual(DEFAULT_LIMITS.signal, { capacity: 120, refillPerSecond: 12 });
  assert.deepEqual(DEFAULT_LIMITS['mic-state'], { capacity: 5, refillPerSecond: 5 });
  assert.deepEqual(DEFAULT_LIMITS.speaking, { capacity: 5, refillPerSecond: 5 });
});
