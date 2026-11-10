// Tests for password/token helpers (pure crypto, no DB needed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, newSalt, generateToken, hashToken } = require('../lib/passwords');

test('hashPassword is deterministic for the same salt', () => {
  const salt = newSalt();
  assert.equal(hashPassword('correct-horse-battery', salt), hashPassword('correct-horse-battery', salt));
  assert.notEqual(hashPassword('wrong-password', salt), hashPassword('correct-horse-battery', salt));
});

test('hashToken is a 64-char hex SHA-256', () => {
  const token = generateToken();
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(token), hashToken(generateToken()));
});

test('generateToken produces unique 64-char tokens', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.equal(a.length, 64);
});
