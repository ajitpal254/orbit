// Tests for fading chat (lib/fadingChat.js + the expireAt fields on the
// Message and DirectMessage models + expiry filtering in lib/dms.js).
// Pure logic + offline model validation — no MongoDB needed, and no
// real 24h waits: every boundary uses fixed dates.
//
// Rules under test (playbook + addendum):
// - messages expire 24h after they are written;
// - expired means expireAt is AT or BEFORE now (at == gone);
// - legacy messages with no expireAt stay visible, never crash;
// - expireAt is set server-side on write (withExpiry overwrites any
//   client-supplied value); the TTL index is background cleanup only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MESSAGE_TTL_MS, expiryFor, isExpired, isVisible, visibleMessages,
  notExpiredFilter, withExpiry
} = require('../lib/fadingChat');
const { unreadFor, lastMessageFor, buildSummaries } = require('../lib/dms');
const Message = require('../models/Message');
const DirectMessage = require('../models/DirectMessage');

const T = new Date('2026-11-11T12:00:00Z'); // fixed "now"
const HOUR = 60 * 60 * 1000;
const at = (ms) => new Date(T.getTime() + ms);
const msg = (expireAt) => (expireAt === undefined ? { text: 'legacy' } : { text: 'x', expireAt });

test('MESSAGE_TTL_MS is exactly 24h', () => {
  assert.equal(MESSAGE_TTL_MS, 24 * 60 * 60 * 1000);
});

test('expiryFor: createdAt + 24h exactly', () => {
  assert.equal(expiryFor(T).toISOString(), '2026-11-12T12:00:00.000Z');
  assert.equal(expiryFor(new Date('2026-01-01T00:00:00Z')).toISOString(), '2026-01-02T00:00:00.000Z');
  const before = Date.now();
  const d = expiryFor();
  assert.ok(d.getTime() - before >= MESSAGE_TTL_MS);
  assert.ok(d.getTime() - before < MESSAGE_TTL_MS + 5000);
});

test('boundary: 23:59:59 visible, 24:00:00 gone, 24:00:01 gone', () => {
  const written = { text: 'x', expireAt: expiryFor(T) }; // expires T + 24h
  assert.equal(isVisible(written, at(24 * HOUR - 1000)), true); // 23:59:59
  assert.equal(isVisible(written, at(24 * HOUR)), false); // exactly at
  assert.equal(isVisible(written, at(24 * HOUR + 1000)), false); // 24:00:01
  assert.equal(isExpired(written, at(24 * HOUR - 1000)), false);
  assert.equal(isExpired(written, at(24 * HOUR)), true);
});

test('boundary: just-before / at / just-after expiry on expireAt itself', () => {
  assert.equal(isExpired(msg(at(-1000)), T), true);
  assert.equal(isExpired(msg(at(0)), T), true); // at == expired
  assert.equal(isExpired(msg(at(1000)), T), false);
  assert.equal(isVisible(msg(at(0)), T), false);
  assert.equal(isVisible(msg(at(1000)), T), true);
});

test('legacy messages with NO expireAt keep working (visible, no crash)', () => {
  assert.equal(isExpired(msg(undefined), T), false);
  assert.equal(isVisible(msg(undefined), T), true);
  assert.equal(isExpired(msg(null), T), false);
  assert.equal(isVisible(msg(null), T), true);
  assert.equal(isExpired(null, T), false);
  assert.equal(isExpired(undefined, T), false);
});

test('visibleMessages: filters expired, keeps legacy + live, preserves order', () => {
  const rows = [msg(at(1000)), msg(undefined), msg(at(-1000)), msg(at(0)), msg(at(60 * HOUR))];
  const out = visibleMessages(rows, T);
  assert.deepEqual(out, [rows[0], rows[1], rows[4]]);
  assert.equal(rows.length, 5); // input not mutated
  assert.deepEqual(visibleMessages([], T), []);
});

test('notExpiredFilter: legacy arm + strict $gt arm, at-or-before excluded', () => {
  const filter = notExpiredFilter(T);
  assert.deepEqual(filter, {
    $or: [{ expireAt: null }, { expireAt: { $gt: T } }]
  });
  // Simulate the fragment's Mongo semantics over fixtures: a doc
  // matches when expireAt is missing/null, or strictly after now.
  const matches = (doc) => doc.expireAt == null || new Date(doc.expireAt) > T;
  assert.equal(matches(msg(undefined)), true); // legacy: no field
  assert.equal(matches(msg(null)), true); // legacy: null
  assert.equal(matches(msg(at(1000))), true); // live
  assert.equal(matches(msg(at(-1000))), false); // expired
  assert.equal(matches(msg(at(0))), false); // at == expired ($gt, not $gte)
  // The filter and the pure helper agree on every fixture.
  const fixtures = [msg(undefined), msg(null), msg(at(1000)), msg(at(-1000)), msg(at(0))];
  assert.deepEqual(fixtures.map((m) => matches(m)), fixtures.map((m) => isVisible(m, T)));
});

test('withExpiry: stamps server-side expireAt, overwrites client values, no mutation', () => {
  const fields = { text: 'hi', expireAt: new Date('2999-01-01T00:00:00Z') }; // client forgery
  const stamped = withExpiry(fields, T);
  assert.equal(stamped.text, 'hi');
  assert.equal(stamped.expireAt.toISOString(), '2026-11-12T12:00:00.000Z');
  assert.equal(fields.expireAt.toISOString(), '2999-01-01T00:00:00.000Z'); // input untouched
  assert.equal(withExpiry({ text: 'hi' }, T).expireAt.toISOString(), '2026-11-12T12:00:00.000Z');
});

test('models: expireAt is a plain Date field (NOT encrypted) with a TTL index', () => {
  for (const Model of [Message, DirectMessage]) {
    assert.equal(Model.schema.path('expireAt').instance, 'Date');
    const ttl = Model.schema.indexes().find(([spec, opts]) =>
      spec.expireAt === 1 && opts.expireAfterSeconds === 0);
    assert.ok(ttl, `${Model.modelName} is missing its TTL index`);
  }
});

test('models: a doc stamped with withExpiry validates; a legacy doc validates too', async () => {
  const oid = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const roomMsg = new Message(withExpiry({
    roomId: oid, userId: oid, name: 'Ajit', text: 'ciphertext'
  }, T));
  await roomMsg.validate();
  assert.ok(roomMsg.expireAt instanceof Date);
  assert.equal(roomMsg.expireAt.toISOString(), '2026-11-12T12:00:00.000Z');
  const legacy = new Message({ roomId: oid, userId: oid, name: 'Ajit', text: 'ciphertext' });
  await legacy.validate();
  assert.equal(legacy.expireAt, undefined);
  const dm = new DirectMessage(withExpiry({
    sender: oid, recipient: 'bbbbbbbbbbbbbbbbbbbbbbbb', text: 'ciphertext'
  }, T));
  await dm.validate();
  assert.ok(dm.expireAt instanceof Date);
});

// --- DM summary helpers must never surface an expired message ---

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const THEM = 'bbbbbbbbbbbbbbbbbbbbbbbb';

test('dms: unreadFor ignores expired unread messages, counts legacy ones', () => {
  const rows = [
    { sender: THEM, recipient: ME, text: 'expired', read: false, createdAt: at(-2 * HOUR), expireAt: at(-HOUR) },
    { sender: THEM, recipient: ME, text: 'legacy', read: false, createdAt: at(-3 * HOUR) }, // no expireAt
    { sender: THEM, recipient: ME, text: 'live', read: false, createdAt: at(-HOUR), expireAt: at(HOUR) },
    { sender: THEM, recipient: ME, text: 'read', read: true, createdAt: at(-HOUR), expireAt: at(HOUR) }
  ];
  assert.equal(unreadFor(rows, ME, THEM, T), 2); // legacy + live only
});

test('dms: lastMessageFor skips the expired latest and falls back to the newest visible', () => {
  const rows = [
    { sender: THEM, recipient: ME, text: 'old visible', read: true, createdAt: at(-2 * HOUR), expireAt: at(HOUR) },
    { sender: THEM, recipient: ME, text: 'newest but expired', read: false, createdAt: at(-1000), expireAt: at(-1000) },
    { sender: ME, recipient: THEM, text: 'legacy mine', read: true, createdAt: at(-3 * HOUR) } // no expireAt
  ];
  const last = lastMessageFor(rows, ME, THEM, T);
  assert.equal(last.text, 'old visible');
  assert.equal(last.fromMe, false);
  // All expired -> null, not the expired text.
  assert.equal(lastMessageFor([rows[1]], ME, THEM, T), null);
});

test('dms: buildSummaries lastMessage + unreadCount ignore expired rows', () => {
  const friends = [{ id: THEM, name: 'Zed', email: 'zed@example.com' }];
  const rows = [
    { sender: THEM, recipient: ME, text: 'expired unread', read: false, createdAt: at(-1000), expireAt: at(-1000) },
    { sender: THEM, recipient: ME, text: 'visible', read: false, createdAt: at(-2 * HOUR), expireAt: at(HOUR) }
  ];
  const [s] = buildSummaries(friends, rows, ME, T);
  assert.equal(s.lastMessage.text, 'visible');
  assert.equal(s.unreadCount, 1);
  const [s2] = buildSummaries(friends, [rows[0]], ME, T);
  assert.equal(s2.lastMessage, null);
  assert.equal(s2.unreadCount, 0);
});
