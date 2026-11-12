// Tests for room postcards (frontend/src/postcard.js, ESM — run via
// node --test *.test.mjs). The card is client-side and in-memory only:
// duration from the voice session's joinedAt, participants from the
// sightings RoomView accumulates during the stay. Nothing here touches
// the server or MongoDB, by design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  formatPostcardDuration,
  formatPostcardDate,
  buildPostcardParticipants,
  buildPostcard
} from '../frontend/src/postcard.js';

test('formatPostcardDuration: seconds, minutes, hours (playbook style)', () => {
  assert.equal(formatPostcardDuration(0), '0s');
  assert.equal(formatPostcardDuration(42000), '42s');
  assert.equal(formatPostcardDuration(59999), '59s');
  assert.equal(formatPostcardDuration(60000), '1m');
  assert.equal(formatPostcardDuration(12 * 60000), '12m');
  assert.equal(formatPostcardDuration(59 * 60000 + 30000), '59m');
  assert.equal(formatPostcardDuration(3600000), '1h 0m');
  assert.equal(formatPostcardDuration(3720000), '1h 2m');
  assert.equal(formatPostcardDuration(4320000), '1h 12m');
});

test('formatPostcardDuration never goes negative or NaN', () => {
  assert.equal(formatPostcardDuration(-5000), '0s');
  assert.equal(formatPostcardDuration(undefined), '0s');
  assert.equal(formatPostcardDuration(null), '0s');
});

test('formatPostcardDate is the short "Nov 11" style', () => {
  assert.equal(formatPostcardDate(new Date(2026, 10, 11, 12).getTime()), 'Nov 11');
  assert.equal(formatPostcardDate(new Date(2026, 0, 5, 12).getTime()), 'Jan 5');
  assert.equal(formatPostcardDate(undefined), '');
  assert.equal(formatPostcardDate(NaN), '');
});

test('buildPostcardParticipants dedupes by user id, first sighting wins', () => {
  const seen = [
    { id: 'u1', name: 'Mia' },
    { id: 'u2', name: 'Tom' },
    // Same person, new socket after a rejoin — one entry, first name.
    { id: 'u1', name: 'Mia Renamed' },
    { id: 'u2', name: 'Tom' }
  ];
  assert.deepEqual(buildPostcardParticipants(seen, 'me'), [
    { id: 'u1', name: 'Mia', avatarPreset: '', avatarImage: '' },
    { id: 'u2', name: 'Tom', avatarPreset: '', avatarImage: '' }
  ]);
});

test('buildPostcardParticipants drops me and entries with no id, keeps first-seen order', () => {
  const seen = [
    { id: 'me', name: 'Ajit' },
    { id: '', name: 'Ghost' },
    { name: 'No id at all' },
    null,
    { id: 'u3', name: 'Priya', avatarPreset: 'nova', avatarImage: '' },
    { id: 'u1', name: 'Mia' }
  ];
  assert.deepEqual(buildPostcardParticipants(seen, 'me'), [
    { id: 'u3', name: 'Priya', avatarPreset: 'nova', avatarImage: '' },
    { id: 'u1', name: 'Mia', avatarPreset: '', avatarImage: '' }
  ]);
});

test('buildPostcardParticipants falls back to Unnamed and carries avatars through', () => {
  const seen = [{ id: 'u9', avatarImage: 'data:image/png;base64,xx' }];
  assert.deepEqual(buildPostcardParticipants(seen, 'me'), [
    { id: 'u9', name: 'Unnamed', avatarPreset: '', avatarImage: 'data:image/png;base64,xx' }
  ]);
});

test('buildPostcard builds the whole card from a stay', () => {
  const joinedAt = new Date(2026, 10, 11, 20, 0, 0).getTime();
  const leftAt = joinedAt + 72 * 60000;
  const card = buildPostcard({
    roomName: 'Late Night',
    joinedAt,
    leftAt,
    seen: [
      { id: 'me', name: 'Ajit' },
      { id: 'u1', name: 'Mia' },
      { id: 'u2', name: 'Tom' }
    ],
    selfId: 'me'
  });
  assert.equal(card.roomName, 'Late Night');
  assert.equal(card.durationMs, 72 * 60000);
  assert.equal(card.durationLabel, '1h 12m');
  assert.equal(card.dateLabel, 'Nov 11');
  assert.equal(card.alone, false);
  assert.deepEqual(card.participants.map((p) => p.name), ['Mia', 'Tom']);
});

test('buildPostcard marks a solo stay as alone', () => {
  const joinedAt = new Date(2026, 10, 11, 20, 0, 0).getTime();
  const card = buildPostcard({
    roomName: 'Solo',
    joinedAt,
    leftAt: joinedAt + 42000,
    seen: [{ id: 'me', name: 'Ajit' }],
    selfId: 'me'
  });
  assert.equal(card.durationLabel, '42s');
  assert.equal(card.alone, true);
  assert.deepEqual(card.participants, []);
});

test('buildPostcard returns null for a campfire, builds for permanent rooms', () => {
  const joinedAt = new Date(2026, 10, 11, 20, 0, 0).getTime();
  const base = {
    roomName: 'Late Night',
    joinedAt,
    leftAt: joinedAt + 72 * 60000,
    seen: [{ id: 'u1', name: 'Mia' }],
    selfId: 'me'
  };
  // Campfire (ephemeral): no card, however long the stay — the
  // hard-delete promise holds, no tombstone or archive.
  assert.equal(buildPostcard({ ...base, ephemeral: true }), null);
  // Permanent, explicit or legacy (no flag): the card builds.
  const permanent = buildPostcard({ ...base, ephemeral: false });
  assert.equal(permanent.roomName, 'Late Night');
  assert.equal(permanent.durationLabel, '1h 12m');
  const legacy = buildPostcard({ ...base, ephemeral: undefined });
  assert.equal(legacy.roomName, 'Late Night');
});

test('buildPostcard returns null without a room name or session start, and clamps negative stays', () => {
  assert.equal(buildPostcard({ roomName: '', joinedAt: 1000, leftAt: 2000, seen: [], selfId: 'me' }), null);
  assert.equal(buildPostcard({ roomName: 'Late Night', joinedAt: null, leftAt: 2000, seen: [], selfId: 'me' }), null);
  assert.equal(buildPostcard({ roomName: 'Late Night', joinedAt: undefined, leftAt: 2000, seen: [], selfId: 'me' }), null);
  const card = buildPostcard({ roomName: 'Late Night', joinedAt: 2000, leftAt: 1000, seen: [], selfId: 'me' });
  assert.equal(card.durationMs, 0);
  assert.equal(card.durationLabel, '0s');
});

// Wiring (source-level, same pattern as tests/appCallbackOrder.test.mjs):
// the leave path must hand RoomView's sightings to App, and App must
// render the card above the rooms list — otherwise the pure functions
// above never reach the screen.
const appSrc = readFileSync(new URL('../frontend/src/App.jsx', import.meta.url), 'utf8');
const roomViewSrc = readFileSync(new URL('../frontend/src/components/RoomView.jsx', import.meta.url), 'utf8');

test('App builds the postcard on leave from the session start + snapshot', () => {
  assert.ok(appSrc.includes("import { buildPostcard } from './postcard'"), 'App should import buildPostcard');
  assert.ok(appSrc.includes('buildPostcard({'), 'leaveRoom should build the postcard');
  assert.ok(appSrc.includes('session.joinedAt'), 'duration must come from the voice session joinedAt');
  assert.ok(appSrc.includes('ephemeral: snapshot.ephemeral'), 'leaveRoom must pass the room\'s campfire state through');
  assert.ok(appSrc.includes('<RoomPostcard postcard={postcard}'), 'App should render the postcard');
  assert.ok(appSrc.includes('setPostcard(null)'), 'joining / dismissing must clear the card');
});

test('RoomView hands its sightings to onLeave on every leave path', () => {
  assert.ok(roomViewSrc.includes('onLeave(buildSnapshot())'), 'leave paths should pass the snapshot');
  assert.ok(roomViewSrc.includes('seenRef'), 'RoomView should accumulate sightings during the stay');
  // Kicked is the one leave with no card: the kicked notice is the message.
  const kicked = roomViewSrc.indexOf('You were removed');
  assert.ok(kicked > 0, 'kicked screen should still exist');
  assert.ok(roomViewSrc.slice(kicked, kicked + 400).includes('onClick={onLeave}'), 'kicked Back-to-rooms passes no snapshot');
});

// Option A (v0.7.0): postcards are permanent-rooms only. The campfire
// faded screen must NOT hand a snapshot over — the faded notice is
// the whole goodbye — and the snapshot itself must carry the room's
// effective campfire state (a kept campfire counts as permanent).
test('RoomView never postcards a campfire: faded screen passes no snapshot', () => {
  const faded = roomViewSrc.indexOf('<h2>This campfire faded</h2>');
  assert.ok(faded > 0, 'faded screen should still exist');
  const fadedBtn = roomViewSrc.slice(faded, faded + 600);
  assert.ok(fadedBtn.includes('onClick={onLeave}'), 'faded Back-to-rooms passes no snapshot');
  assert.ok(!fadedBtn.includes('buildSnapshot'), 'faded screen must not build a snapshot');
  assert.ok(roomViewSrc.includes('ephemeral: room.ephemeral && !kept'), 'snapshot must carry the effective campfire state (kept counts as permanent)');
});
