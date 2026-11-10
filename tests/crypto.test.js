// Tests for AES-256-GCM field encryption (lib/crypto.js).
// No DB needed. The key is fixed via env BEFORE requiring the module so
// the round-trip is deterministic across runs.
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt, isKeyEphemeral, _resetKeyCacheForTests } = require('../lib/crypto');

test('crypto round-trips short, empty, unicode, and 1000-char messages', () => {
  const samples = [
    'hello world',
    '',
    'नमस्ते — café ☕ emoji 🎉',
    'x'.repeat(1000),
    JSON.stringify({ room: 'test', n: 42 })
  ];
  for (const s of samples) {
    assert.equal(decrypt(encrypt(s)), s);
  }
});

test('crypto format is base64 iv:authTag:ciphertext', () => {
  const blob = encrypt('check format');
  const parts = blob.split(':');
  assert.equal(parts.length, 3);
  for (const p of parts) {
    assert.match(p, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.ok(Buffer.from(p, 'base64').length > 0);
  }
  // IV 12 bytes, auth tag 16 bytes.
  assert.equal(Buffer.from(parts[0], 'base64').length, 12);
  assert.equal(Buffer.from(parts[1], 'base64').length, 16);
});

test('crypto uses a fresh random IV — same plaintext encrypts differently', () => {
  assert.notEqual(encrypt('same text'), encrypt('same text'));
  assert.equal(decrypt(encrypt('same text')), 'same text');
});

test('crypto tamper detection: flipping a byte in the ciphertext fails', () => {
  const blob = encrypt('do not tamper with this');
  const parts = blob.split(':');
  // Flip the first base64 char of the ciphertext part to a different char.
  const tampered = parts[2][0] === 'A' ? 'B' + parts[2].slice(1) : 'A' + parts[2].slice(1);
  assert.throws(() => decrypt([parts[0], parts[1], tampered].join(':')), /Unable to authenticate|Unsupported state|Invalid authentication/i);
});

test('crypto tamper detection: flipping a byte in the auth tag fails', () => {
  const blob = encrypt('do not tamper with this either');
  const parts = blob.split(':');
  const tampered = parts[1][0] === 'A' ? 'B' + parts[1].slice(1) : 'A' + parts[1].slice(1);
  assert.throws(() => decrypt([parts[0], tampered, parts[2]].join(':')));
});

test('crypto rejects malformed payloads', () => {
  assert.throws(() => decrypt('not-a-blob'), /Invalid encrypted payload/);
  assert.throws(() => decrypt('a:b'), /Invalid encrypted payload/);
  assert.throws(() => decrypt(''), /Invalid encrypted payload/);
});

test('crypto wrong key cannot decrypt (key loss = unreadable data)', () => {
  const blob = encrypt('secret that must stay secret');
  // Swap in a different key and confirm the old blob is now unreadable.
  _resetKeyCacheForTests();
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  assert.throws(() => decrypt(blob));
  // Restore the original key for any later tests in this file.
  _resetKeyCacheForTests();
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  assert.equal(decrypt(blob), 'secret that must stay secret');
});

test('crypto with a valid persistent key is not ephemeral', () => {
  assert.equal(isKeyEphemeral(), false);
});
