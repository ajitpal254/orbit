// Tests for time-of-day backgrounds (v0.7.0): the daypart
// derivation in frontend/src/daypart.js — the four palettes and
// their boundaries, from local time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAYPARTS, DAYPART_META, daypartFor, isValidDaypart, daypartLabel } from '../frontend/src/daypart.js';

const at = (h, m = 0) => new Date(2026, 5, 15, h, m, 0); // a local-time date

test('daypart: the four parts, in order', () => {
  assert.deepEqual(DAYPARTS, ['dawn', 'day', 'dusk', 'night']);
  for (const d of DAYPARTS) {
    assert.ok(DAYPART_META[d].label.length > 0);
    assert.ok(DAYPART_META[d].hours.length > 0);
    assert.equal(isValidDaypart(d), true);
  }
  assert.equal(isValidDaypart('noon'), false);
  assert.equal(daypartLabel('dawn'), 'Dawn');
  assert.equal(daypartLabel('bogus'), 'Night');
});

test('daypart: boundaries are exact — dawn 5–10, day 10–17, dusk 17–21, night 21–5', () => {
  assert.equal(daypartFor(at(4, 59)), 'night');
  assert.equal(daypartFor(at(5, 0)), 'dawn');
  assert.equal(daypartFor(at(7, 30)), 'dawn');
  assert.equal(daypartFor(at(9, 59)), 'dawn');
  assert.equal(daypartFor(at(10, 0)), 'day');
  assert.equal(daypartFor(at(13, 0)), 'day');
  assert.equal(daypartFor(at(16, 59)), 'day');
  assert.equal(daypartFor(at(17, 0)), 'dusk');
  assert.equal(daypartFor(at(19, 45)), 'dusk');
  assert.equal(daypartFor(at(20, 59)), 'dusk');
  assert.equal(daypartFor(at(21, 0)), 'night');
  assert.equal(daypartFor(at(0, 0)), 'night');
  assert.equal(daypartFor(at(2, 15)), 'night');
});

test('daypart: midnight and noon are night and day', () => {
  assert.equal(daypartFor(at(0)), 'night');
  assert.equal(daypartFor(at(12)), 'day');
});
