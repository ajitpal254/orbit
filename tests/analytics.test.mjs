// Tests for GA4 (frontend/src/analytics.js).
// The module touches no DOM at import time, so it runs in plain Node
// with fake window/document/navigator envs passed in.
//
// Guarantees under test:
//   - No Measurement ID -> complete no-op (no script, no gtag, no calls).
//   - Do Not Track set -> gtag is never loaded.
//   - Loaded only once, with anonymize_ip and manual page_view config.
//   - page_view sends only the view name — never the URL (the SPA URL
//     can carry an invite token in its hash).
//   - Event payloads contain no PII: string params are dropped, only
//     numeric allowlisted params survive.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GTAG_SCRIPT_URL,
  getGaMeasurementId,
  isDoNotTrackEnabled,
  shouldLoadAnalytics,
  initAnalytics,
  isAnalyticsEnabled,
  trackPageView,
  trackEvent,
  resetAnalyticsForTests
} from '../frontend/src/analytics.js';

const ID = 'G-ABC12345';

// Fake browser env: a window with a dataLayer, a document whose head
// records appended scripts, and a navigator with an optional DNT flag.
const makeEnv = (dnt) => {
  const scripts = [];
  const win = {};
  const doc = {
    head: { appendChild: (el) => scripts.push(el) },
    createElement: (tag) => ({ tagName: String(tag).toUpperCase() })
  };
  const nav = dnt === undefined ? {} : { doNotTrack: dnt };
  return { env: { window: win, document: doc, navigator: nav }, win, scripts, doc };
};

// dataLayer entries are `arguments` objects — normalise to plain arrays.
const callsOf = (win) => (win.dataLayer || []).map((args) => Array.from(args));

beforeEach(() => { resetAnalyticsForTests(); });

test('getGaMeasurementId: null/empty/malformed -> null, valid ID trimmed + upper-cased', () => {
  assert.equal(getGaMeasurementId({}), null);
  assert.equal(getGaMeasurementId({ gaMeasurementId: null }), null);
  assert.equal(getGaMeasurementId({ gaMeasurementId: '' }), null);
  assert.equal(getGaMeasurementId({ gaMeasurementId: '   ' }), null);
  assert.equal(getGaMeasurementId({ gaMeasurementId: 'UA-12345-1' }), null);
  assert.equal(getGaMeasurementId({ gaMeasurementId: 'not-an-id' }), null);
  assert.equal(getGaMeasurementId({ gaMeasurementId: 'G-12' }), null);
  assert.equal(getGaMeasurementId(null), null);
  assert.equal(getGaMeasurementId(undefined), null);
  assert.equal(getGaMeasurementId({ gaMeasurementId: `  ${ID}  ` }), ID);
  assert.equal(getGaMeasurementId({ gaMeasurementId: 'g-abc12345' }), ID);
});

test('isDoNotTrackEnabled: "1" and "yes" count, "0"/unset do not', () => {
  assert.equal(isDoNotTrackEnabled({ doNotTrack: '1' }, {}), true);
  assert.equal(isDoNotTrackEnabled({ doNotTrack: 'yes' }, {}), true);
  assert.equal(isDoNotTrackEnabled({ doNotTrack: '0' }, {}), false);
  assert.equal(isDoNotTrackEnabled({ doNotTrack: 'unspecified' }, {}), false);
  assert.equal(isDoNotTrackEnabled({}, {}), false);
  assert.equal(isDoNotTrackEnabled(null, {}), false);
  // window.doNotTrack fallback (old Safari/IE path).
  assert.equal(isDoNotTrackEnabled({}, { doNotTrack: '1' }), true);
  assert.equal(isDoNotTrackEnabled({}, { doNotTrack: 'yes' }), true);
  assert.equal(isDoNotTrackEnabled({}, {}), false);
});

test('shouldLoadAnalytics: needs an ID and no DNT', () => {
  assert.equal(shouldLoadAnalytics(ID, {}, {}), true);
  assert.equal(shouldLoadAnalytics(null, {}, {}), false);
  assert.equal(shouldLoadAnalytics('', {}, {}), false);
  assert.equal(shouldLoadAnalytics(ID, { doNotTrack: '1' }, {}), false);
  assert.equal(shouldLoadAnalytics(ID, { doNotTrack: 'yes' }, {}), false);
});

test('initAnalytics with no ID: complete no-op — no script, no gtag, no dataLayer calls', () => {
  const { env, win, scripts } = makeEnv();
  assert.equal(initAnalytics(null, env), false);
  assert.equal(initAnalytics('', env), false);
  assert.equal(initAnalytics('UA-12345-1', env), false);
  assert.equal(isAnalyticsEnabled(), false);
  assert.equal(scripts.length, 0);
  assert.equal(typeof win.gtag, 'undefined');
  assert.equal(win.dataLayer, undefined);
});

test('initAnalytics with Do Not Track set: gtag never loaded', () => {
  const { env, win, scripts } = makeEnv('1');
  assert.equal(initAnalytics(ID, env), false);
  assert.equal(isAnalyticsEnabled(), false);
  assert.equal(scripts.length, 0);
  assert.equal(typeof win.gtag, 'undefined');
  const { env: envYes } = makeEnv('yes');
  assert.equal(initAnalytics(ID, envYes), false);
});

test('initAnalytics loads gtag.js once, with anonymize_ip + manual page_view', () => {
  const { env, win, scripts } = makeEnv();
  assert.equal(initAnalytics(ID, env), true);
  assert.equal(isAnalyticsEnabled(), true);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, `${GTAG_SCRIPT_URL}?id=${ID}`);
  assert.equal(scripts[0].async, true);
  assert.equal(typeof win.gtag, 'function');
  const calls = callsOf(win);
  assert.deepEqual(calls[0][0], 'js');
  assert.ok(calls[0][1] instanceof Date);
  assert.deepEqual(calls[1], ['config', ID, { anonymize_ip: true, send_page_view: false }]);
  // Second init does not inject a second script tag.
  assert.equal(initAnalytics(ID, env), true);
  assert.equal(scripts.length, 1);
});

test('trackPageView is a no-op before init; after init it sends only the view name', () => {
  const { env, win } = makeEnv();
  assert.equal(trackPageView('rooms', env), false);
  initAnalytics(ID, env);
  assert.equal(trackPageView('friends', env), true);
  assert.equal(trackPageView('room', env), true);
  const calls = callsOf(win);
  const pageViews = calls.filter((c) => c[0] === 'event' && c[1] === 'page_view');
  assert.equal(pageViews.length, 2);
  // Only the coarse view name — no page_location / page_path: the SPA
  // URL can carry an invite token in its hash.
  assert.deepEqual(pageViews[0][2], { page_title: 'friends' });
  assert.deepEqual(pageViews[1][2], { page_title: 'room' });
  assert.equal(JSON.stringify(pageViews).includes('page_location'), false);
  assert.equal(JSON.stringify(pageViews).includes('page_path'), false);
  // Unknown views are ignored, not sent.
  assert.equal(trackPageView('settings', env), false);
  assert.equal(trackPageView('', env), false);
  assert.equal(callsOf(win).filter((c) => c[1] === 'page_view').length, 2);
});

test('trackEvent payloads contain no PII: strings dropped, only numeric allowlisted params survive', () => {
  const { env, win } = makeEnv();
  assert.equal(trackEvent('room_joined', {}, env), false); // not initialised yet
  initAnalytics(ID, env);
  assert.equal(trackEvent('room_joined', {
    roomName: 'Secret Birthday Room',
    roomId: '507f1f77bcf86cd799439011',
    userId: '507f1f77bcf86cd799439012',
    email: 'ajit@example.com',
    message: 'meet me at midnight, password hunter2'
  }, env), true);
  assert.equal(trackEvent('focus_started', {
    duration_minutes: 25,
    roomId: '507f1f77bcf86cd799439011',
    roomName: 'Secret Birthday Room'
  }, env), true);
  // Unknown event names never fire.
  assert.equal(trackEvent('room_created_by_ajit@example.com', {}, env), false);
  assert.equal(trackEvent('chat_message_sent', { text: 'hello' }, env), false);

  const events = callsOf(win).filter((c) => c[0] === 'event' && c[1] !== 'page_view');
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], ['event', 'room_joined', {}]);
  assert.deepEqual(events[1], ['event', 'focus_started', { duration_minutes: 25 }]);
  // Belt and braces: the exact serialised payload carries none of it.
  const blob = JSON.stringify(events);
  for (const secret of [
    'Secret Birthday Room', '507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012',
    'ajit@example.com', 'meet me at midnight', 'hunter2'
  ]) {
    assert.equal(blob.includes(secret), false, `payload leaked: ${secret}`);
  }
  // Non-finite / non-numeric "coarse" params are dropped too.
  assert.equal(trackEvent('focus_ended', { duration_minutes: NaN, value: Infinity, occupant_count: 3 }, env), true);
  const last = callsOf(win).at(-1);
  assert.deepEqual(last, ['event', 'focus_ended', { occupant_count: 3 }]);
});
