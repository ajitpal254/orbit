// Tests for direct messages: the pure helpers in lib/dms.js and model
// validation (no MongoDB needed — validate() runs offline; unique
// indexes are only enforced by the database, so they are not asserted
// here).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canDm, unreadFor, lastMessageFor, buildSummaries } = require('../lib/dms');
const DirectMessage = require('../models/DirectMessage');

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const THEM = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const STRANGER = 'cccccccccccccccccccccccc';

const acceptedAB = { requester: ME, recipient: THEM, status: 'accepted' };
const pendingAB = { requester: ME, recipient: THEM, status: 'pending' };

const m1 = { sender: THEM, recipient: ME, text: 'hey', read: false, createdAt: new Date('2026-11-11T00:00:00Z') };
const m2 = { sender: ME, recipient: THEM, text: 'hi back', read: true, createdAt: new Date('2026-11-11T00:01:00Z') };
const m3 = { sender: THEM, recipient: ME, text: 'again', read: false, createdAt: new Date('2026-11-11T00:02:00Z') };
const mOther = { sender: STRANGER, recipient: ME, text: 'nope', read: false, createdAt: new Date('2026-11-11T00:03:00Z') };

test('canDm: only accepted friends, never pending or strangers', () => {
  assert.equal(canDm([acceptedAB], ME, THEM), true);
  assert.equal(canDm([pendingAB], ME, THEM), false);
  assert.equal(canDm([], ME, THEM), false);
  assert.equal(canDm([acceptedAB], ME, STRANGER), false);
});

test('unreadFor: only their unread messages to me', () => {
  assert.equal(unreadFor([m1, m2, m3, mOther], ME, THEM), 2);
  assert.equal(unreadFor([m1, m2, m3], THEM, ME), 0); // my messages to them are not unread for them here
  assert.equal(unreadFor([], ME, THEM), 0);
});

test('lastMessageFor: newest between the pair, with fromMe flag', () => {
  const last = lastMessageFor([m1, m2, m3, mOther], ME, THEM);
  assert.equal(last.text, 'again');
  assert.equal(last.fromMe, false);
  assert.equal(lastMessageFor([m1, m2], ME, THEM).text, 'hi back');
  assert.equal(lastMessageFor([m1, m2], ME, THEM).fromMe, true);
  assert.equal(lastMessageFor([mOther], ME, THEM), null);
  assert.equal(lastMessageFor([], ME, THEM), null);
});

test('buildSummaries: recency desc, no-message friends last by name', () => {
  const friends = [
    { id: THEM, name: 'Zed', email: 'zed@example.com' },
    { id: STRANGER, name: 'Amy', email: 'amy@example.com' },
    { id: 'dddddddddddddddddddddddd', name: 'Bob', email: 'bob@example.com' }
  ];
  const summaries = buildSummaries(friends, [m1, m2, m3], ME);
  // THEM has messages (latest 00:02); Amy and Bob have none, name order.
  assert.deepEqual(summaries.map((s) => s.name), ['Zed', 'Amy', 'Bob']);
  assert.equal(summaries[0].unreadCount, 2);
  assert.equal(summaries[0].lastMessage.text, 'again');
  assert.equal(summaries[0].lastMessage.fromMe, false);
  assert.equal(summaries[1].lastMessage, null);
  assert.equal(summaries[1].unreadCount, 0);
});

test('buildSummaries: recency order follows the latest message, not the first', () => {
  const friends = [
    { id: THEM, name: 'Zed', email: 'zed@example.com' },
    { id: STRANGER, name: 'Amy', email: 'amy@example.com' }
  ];
  const newer = { sender: STRANGER, recipient: ME, text: 'later', read: false, createdAt: new Date('2026-11-11T01:00:00Z') };
  const summaries = buildSummaries(friends, [m1, m2, m3, newer], ME);
  assert.deepEqual(summaries.map((s) => s.name), ['Amy', 'Zed']);
  assert.equal(summaries[0].unreadCount, 1);
});

test('DirectMessage model: required fields + read defaults to false', () => {
  const dm = new DirectMessage({
    sender: ME, recipient: THEM, text: 'iv:tag:ciphertext'
  });
  assert.equal(dm.validateSync(), undefined);
  assert.equal(dm.read, false);
  const bad = new DirectMessage({ sender: ME });
  const err = bad.validateSync();
  assert.ok(err.errors.recipient);
  assert.ok(err.errors.text);
});
