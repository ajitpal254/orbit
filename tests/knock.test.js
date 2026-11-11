// Tests for knock (lib/knock.js + the Knock model).
// Pure logic + model validation — no MongoDB needed, and no real 24h
// waits: every boundary uses fixed dates.
//
// Rules under test (playbook Prompt B item 2 + addendum §2 item 3,
// adapted to the room knock this feature ships):
// - only a non-member friend of the room OWNER may knock (private
//   rooms only; a friend of some other member is not enough);
// - only the owner/moderators may admit or decline;
// - 1 knock per 30s per (knocker, room) pair;
// - an unanswered knock expires after 24h; expiry is at-or-before
//   (at == gone), enforced at read time as well as by the TTL index;
// - a pending knock is found by (room, user); answered/expired ones
//   are not.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  KNOCK_TTL_MS, KNOCK_RATE_LIMIT_MS,
  expiryForKnock, isKnockExpired, isKnockPending, isKnockRateLimited,
  canKnock, knockBlockReason, canAnswerKnock,
  findPendingKnock, notExpiredKnockFilter, knockJson
} = require('../lib/knock');
const Knock = require('../models/Knock');

const T = new Date('2026-11-11T12:00:00Z'); // fixed "now"
const SECOND = 1000;
const HOUR = 60 * 60 * 1000;
const at = (ms) => new Date(T.getTime() + ms);

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const KNOCKER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const MOD = 'cccccccccccccccccccccccc';
const MEMBER = 'dddddddddddddddddddddddd';
const STRANGER = 'eeeeeeeeeeeeeeeeeeeeeeee';
const ROOM_ID = 'ffffffffffffffffffffffff';

// Private room owned by OWNER, MOD is a moderator, MEMBER a plain member.
const room = (extra = {}) => ({
  _id: ROOM_ID,
  isPrivate: true,
  createdBy: OWNER,
  members: [
    { user: OWNER, role: 'owner' },
    { user: MOD, role: 'moderator' },
    { user: MEMBER, role: 'member' }
  ],
  ...extra
});

// Accepted friendship between KNOCKER and OWNER (either direction).
const friendRows = (a = KNOCKER, b = OWNER) => ([
  { requester: a, recipient: b, status: 'accepted' }
]);

const knock = (extra = {}) => ({
  _id: '111111111111111111111111',
  room: ROOM_ID,
  user: KNOCKER,
  status: 'pending',
  createdAt: T,
  expiresAt: expiryForKnock(T),
  ...extra
});

test('KNOCK_TTL_MS is exactly 24h; rate limit is exactly 30s', () => {
  assert.equal(KNOCK_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(KNOCK_RATE_LIMIT_MS, 30 * 1000);
});

test('expiryForKnock: createdAt + 24h exactly', () => {
  assert.equal(expiryForKnock(T).toISOString(), '2026-11-12T12:00:00.000Z');
});

test('boundary: 23h59m59s alive, 24h gone, 24h+1s gone (expiresAt itself)', () => {
  const k = knock();
  assert.equal(isKnockExpired(k, at(24 * HOUR - SECOND)), false);
  assert.equal(isKnockExpired(k, at(24 * HOUR)), true); // exactly at
  assert.equal(isKnockExpired(k, at(24 * HOUR + SECOND)), true);
  assert.equal(isKnockPending(k, at(24 * HOUR - SECOND)), true);
  assert.equal(isKnockPending(k, at(24 * HOUR)), false);
});

test('boundary: just-before / at / just-after expiry on expiresAt itself', () => {
  assert.equal(isKnockExpired(knock({ expiresAt: at(-1000) }), T), true);
  assert.equal(isKnockExpired(knock({ expiresAt: at(0) }), T), true); // at == expired
  assert.equal(isKnockExpired(knock({ expiresAt: at(1000) }), T), false);
  // No expiresAt never expires (defensive — the route always sets one).
  assert.equal(isKnockExpired(knock({ expiresAt: null }), T), false);
  assert.equal(isKnockExpired(null, T), false);
});

test('isKnockPending: only pending + unexpired counts', () => {
  assert.equal(isKnockPending(knock(), T), true);
  assert.equal(isKnockPending(knock({ status: 'admitted' }), T), false);
  assert.equal(isKnockPending(knock({ status: 'declined' }), T), false);
  assert.equal(isKnockPending(knock({ expiresAt: at(-1) }), T), false);
  assert.equal(isKnockPending(null, T), false);
});

test('rate limit: within 30s blocked, at 30s free', () => {
  assert.equal(isKnockRateLimited(at(-29 * SECOND), T), true);
  assert.equal(isKnockRateLimited(at(-30 * SECOND), T), false); // exactly 30s
  assert.equal(isKnockRateLimited(at(-31 * SECOND), T), false);
  assert.equal(isKnockRateLimited(at(-60 * SECOND), T), false);
  assert.equal(isKnockRateLimited(null, T), false);
  assert.equal(isKnockRateLimited(undefined, T), false);
});

test('canKnock: non-member friend of the owner may knock', () => {
  assert.equal(canKnock(room(), KNOCKER, friendRows()), true);
  // Friendship in the other direction counts too.
  assert.equal(canKnock(room(), KNOCKER, friendRows(OWNER, KNOCKER)), true);
});

test('canKnock: public rooms never take knocks', () => {
  assert.equal(canKnock(room({ isPrivate: false }), KNOCKER, friendRows()), false);
  assert.equal(canKnock(room({ isPrivate: undefined }), KNOCKER, friendRows()), false);
});

test('canKnock: members never knock on their own room', () => {
  assert.equal(canKnock(room(), OWNER, friendRows()), false);
  assert.equal(canKnock(room(), MOD, friendRows(MOD, OWNER)), false);
  assert.equal(canKnock(room(), MEMBER, friendRows(MEMBER, OWNER)), false);
});

test('canKnock: strangers cannot knock — friendship with the owner is required', () => {
  // No friendship at all.
  assert.equal(canKnock(room(), STRANGER, []), false);
  // Pending (not accepted) friendship is not enough.
  assert.equal(canKnock(room(), KNOCKER, [{ requester: KNOCKER, recipient: OWNER, status: 'pending' }]), false);
  // Friend of a moderator/member, but NOT of the owner, is not enough.
  assert.equal(canKnock(room(), KNOCKER, friendRows(KNOCKER, MOD)), false);
  assert.equal(canKnock(room(), KNOCKER, friendRows(KNOCKER, MEMBER)), false);
});

test('canKnock: null room / null user never knocks', () => {
  assert.equal(canKnock(null, KNOCKER, friendRows()), false);
  assert.equal(canKnock(room(), null, friendRows()), false);
});

test('knockBlockReason: the locked-room screen gets a friendly reason', () => {
  assert.equal(knockBlockReason(room(), KNOCKER, friendRows()), '');
  assert.equal(knockBlockReason(null, KNOCKER, []), 'Room not found');
  assert.equal(knockBlockReason(room({ isPrivate: false }), KNOCKER, friendRows()), 'Only private rooms take knocks');
  assert.equal(knockBlockReason(room(), MEMBER, friendRows()), 'You are already a member of this room');
  assert.match(knockBlockReason(room(), STRANGER, []), /friends of the room owner/);
});

test('canAnswerKnock: owner and moderators only', () => {
  assert.equal(canAnswerKnock(room(), OWNER), true);
  assert.equal(canAnswerKnock(room(), MOD), true);
  assert.equal(canAnswerKnock(room(), MEMBER), false);
  assert.equal(canAnswerKnock(room(), KNOCKER), false);
  assert.equal(canAnswerKnock(room(), STRANGER), false);
  assert.equal(canAnswerKnock(null, OWNER), false);
});

test('findPendingKnock: finds the pending knock for (room, user) only', () => {
  const list = [
    knock(),
    knock({ _id: '222222222222222222222222', user: STRANGER }),
    knock({ _id: '333333333333333333333333', status: 'declined' }),
    knock({ _id: '444444444444444444444444', expiresAt: at(-1) })
  ];
  assert.equal(findPendingKnock(list, ROOM_ID, KNOCKER, T).user, KNOCKER);
  // Each (room, user) pair has its own pending knock.
  assert.equal(findPendingKnock(list, ROOM_ID, STRANGER, T).user, STRANGER);
  assert.equal(findPendingKnock(list, ROOM_ID, MEMBER, T), null);
  assert.equal(findPendingKnock([], ROOM_ID, KNOCKER, T), null);
  // An expired pending knock is not "pending" anymore.
  assert.equal(findPendingKnock([knock({ expiresAt: at(-1) })], ROOM_ID, KNOCKER, T), null);
});

test('notExpiredKnockFilter: expired knocks are filtered at read time', () => {
  assert.deepEqual(notExpiredKnockFilter(T), {
    $or: [{ expiresAt: null }, { expiresAt: { $gt: T } }]
  });
});

test('knockJson shapes room + knocker for the UI', () => {
  const j = knockJson(
    knock(),
    { _id: ROOM_ID, name: 'Late Night' },
    { _id: KNOCKER, name: 'Mia', avatarPreset: 'nova', avatarImage: '' }
  );
  assert.equal(j.id, '111111111111111111111111');
  assert.deepEqual(j.room, { id: ROOM_ID, name: 'Late Night' });
  assert.deepEqual(j.user, { id: KNOCKER, name: 'Mia', avatarPreset: 'nova', avatarImage: '' });
  assert.equal(j.status, 'pending');
  assert.equal(j.expiresAt.toISOString(), '2026-11-12T12:00:00.000Z');
  // Missing room/user degrade to id-only instead of crashing the list.
  const bare = knockJson(knock(), null, null);
  assert.deepEqual(bare.room, { id: ROOM_ID, name: '' });
  assert.equal(bare.user.id, KNOCKER);
  assert.equal(bare.user.name, '');
});

test('Knock model validates offline (no MongoDB)', () => {
  const ok = new Knock({
    room: ROOM_ID, user: KNOCKER, status: 'pending',
    expiresAt: expiryForKnock(T)
  });
  assert.equal(ok.validateSync(), undefined);
  assert.equal(ok.status, 'pending');
  // Missing room / user / bad status fail validation.
  assert.ok(new Knock({ user: KNOCKER }).validateSync());
  assert.ok(new Knock({ room: ROOM_ID }).validateSync());
  assert.ok(new Knock({ room: ROOM_ID, user: KNOCKER, status: 'maybe' }).validateSync());
});

// --- Wiring: the routes + UI exist and are connected (source checks,
// same pattern as tests/mobile.test.mjs — no MongoDB, no DOM). ---
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const src = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

test('wiring: knock routes exist in routes/api.js', () => {
  const api = src('routes/api.js');
  for (const route of [
    "router.post('/rooms/:id/knock'",
    "router.get('/rooms/:id/knock'",
    "router.delete('/rooms/:id/knock'",
    "router.get('/rooms/:id/knocks'",
    "router.post('/knocks/:id/admit'",
    "router.post('/knocks/:id/decline'"
  ]) assert.ok(api.includes(route), `missing route: ${route}`);
  // A faded campfire answers 410 before any knock logic runs.
  assert.ok(api.includes("if (!isVisible(room)) return res.status(410).json({ error: 'This campfire has already faded' })"));
  // The fading-rooms worker is untouched by this feature.
  assert.ok(!src('lib/fadingRooms.js').includes('Knock'), 'knock must not touch the fading-rooms worker');
});

test('wiring: App listens for knock pushes and renders the locked room', () => {
  const app = src('frontend/src/App.jsx');
  assert.ok(app.includes("socket.on('knock-received', onNotify)"));
  assert.ok(app.includes("socket.on('knock-admitted', onNotify)"));
  assert.ok(app.includes('<LockedRoom'));
  assert.ok(app.includes('err.room'));
  // handleNotifNavigate stays below joinRoom/goTo (guarded by
  // tests/appCallbackOrder.test.mjs too — this is the same rule).
  assert.ok(app.indexOf('const joinRoom') < app.indexOf('const handleNotifNavigate'));
});

test('wiring: RoomView has the admit/decline panel for owner/mods', () => {
  const view = src('frontend/src/components/RoomView.jsx');
  assert.ok(view.includes('getRoomKnocks'));
  assert.ok(view.includes('admitKnock'));
  assert.ok(view.includes('declineKnock'));
  assert.ok(view.includes('knock-received'));
  assert.ok(view.includes('Knocking ('));
});

test('wiring: notifications map the knock type, and the icon exists', () => {
  const notifs = src('frontend/src/components/Notifications.jsx');
  assert.ok(notifs.includes("knock: 'knock'"));
  assert.ok(notifs.includes("n.type === 'knock'"));
  assert.ok(src('frontend/src/iconPaths.js').includes('knock: ['));
  assert.ok(src('frontend/src/api.js').includes('knockOnRoom'));
});
