// Regression test for the Mongoose "Duplicate schema index on
// {"expiresAt":1}" boot warning on the InviteLink model.
//
// The expiresAt field used to carry `index: true` AND the schema
// declared an explicit TTL index on the same field. Mongoose warned
// at boot and silently dropped the TTL options from the duplicate
// definition, so expired private-room links were never cleaned up
// by the TTL monitor. The fix: the field carries no index; the
// explicit TTL index below is the single definition.
//
// Pure schema inspection — no MongoDB needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const InviteLink = require('../models/InviteLink');

test('InviteLink has exactly one expiresAt index, and it is the TTL index', () => {
  const expiresAtIndexes = InviteLink.schema.indexes().filter(([key]) =>
    Object.keys(key).length === 1 && key.expiresAt === 1
  );
  assert.equal(expiresAtIndexes.length, 1, 'expected a single expiresAt index');
  const [, options] = expiresAtIndexes[0];
  assert.equal(options.expireAfterSeconds, 0, 'TTL index must expire at expiresAt');
});
