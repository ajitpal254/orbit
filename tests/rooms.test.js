// Tests for Orbit's pure room helpers + presence registry.
// Full route/socket tests need MongoDB (not available in this sandbox).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ACCENTS, accentById, validateRoomInput, initials, hashString, validateMessageInput
} = require('../lib/rooms');
const presence = require('../lib/presence');

test('ACCENTS has 6 distinct entries with from/to colors', () => {
  assert.equal(ACCENTS.length, 6);
  const ids = new Set(ACCENTS.map((a) => a.id));
  assert.equal(ids.size, 6);
  for (const a of ACCENTS) {
    assert.match(a.from, /^#[0-9a-f]{6}$/);
    assert.match(a.to, /^#[0-9a-f]{6}$/);
  }
});

test('accentById falls back to the first accent on unknown id', () => {
  assert.equal(accentById('violet').id, 'violet');
  assert.equal(accentById('nope').id, ACCENTS[0].id);
  assert.equal(accentById(undefined).id, ACCENTS[0].id);
});

test('validateRoomInput accepts a good room and defaults accent', () => {
  const r = validateRoomInput({ name: '  Late Night  ', topic: 'chilling' });
  assert.equal(r.ok, true);
  assert.equal(r.room.name, 'Late Night');
  assert.equal(r.room.accent, 'violet');
});

test('validateRoomInput rejects empty and overlong names/topics', () => {
  assert.equal(validateRoomInput({ name: '   ' }).ok, false);
  assert.equal(validateRoomInput({ name: 'x'.repeat(61) }).ok, false);
  assert.equal(validateRoomInput({ name: 'ok', topic: 'x'.repeat(141) }).ok, false);
  assert.match(validateRoomInput({ name: '' }).error, /name/i);
});

test('validateRoomInput keeps a valid accent', () => {
  const r = validateRoomInput({ name: 'Room', accent: 'amber' });
  assert.equal(r.room.accent, 'amber');
});

test('initials handles names', () => {
  assert.equal(initials('Ajit Pal'), 'AP');
  assert.equal(initials('ajit'), 'AJ');
  assert.equal(initials('  '), '?');
  assert.equal(initials('Mary Jane Watson'), 'MW');
});

test('hashString is deterministic and spreads values', () => {
  assert.equal(hashString('ajit'), hashString('ajit'));
  assert.notEqual(hashString('ajit'), hashString('riya'));
  assert.equal(typeof hashString('x'), 'number');
});

test('validateMessageInput trims and enforces limits', () => {
  assert.equal(validateMessageInput({ text: '  hello  ' }).text, 'hello');
  assert.equal(validateMessageInput({ text: '   ' }).ok, false);
  assert.equal(validateMessageInput({ text: 'x'.repeat(1001) }).ok, false);
});

test('presence: add/occupants/remove lifecycle', () => {
  presence.clearAll();
  presence.addOccupant('room1', 's1', { id: 'u1', name: 'Ajit' });
  presence.addOccupant('room1', 's2', { id: 'u2', name: 'Riya' });
  assert.equal(presence.occupancyCount('room1'), 2);
  const occ = presence.occupants('room1');
  assert.deepEqual(occ.map((o) => o.name).sort(), ['Ajit', 'Riya']);
  assert.equal(presence.speakingUserIds('room1').length, 0);
  presence.setSpeaking('room1', 's1', true);
  assert.deepEqual(presence.speakingUserIds('room1'), ['u1']);
  const removed = presence.removeOccupant('room1', 's1');
  assert.equal(removed.name, 'Ajit');
  assert.equal(presence.occupancyCount('room1'), 1);
  presence.clearAll();
});

test('presence: removeSocketEverywhere leaves all rooms', () => {
  presence.clearAll();
  presence.addOccupant('r1', 's1', { id: 'u1', name: 'A' });
  presence.addOccupant('r2', 's1', { id: 'u1', name: 'A' });
  const left = presence.removeSocketEverywhere('s1');
  assert.deepEqual(left.sort(), ['r1', 'r2']);
  assert.equal(presence.occupancyCount('r1'), 0);
  presence.clearAll();
});
