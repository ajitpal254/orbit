// Google Analytics 4 (GA4) — privacy-first, runtime-configured, no-op by default.
//
// How it works:
//   - The server reports its GA4 Measurement ID (env GA_MEASUREMENT_ID)
//     via GET /api/config; with no ID configured this module never loads
//     anything — no script tag, no network calls, no errors.
//   - gtag.js is loaded only when an ID is configured AND the user has
//     not enabled Do Not Track (navigator.doNotTrack / window.doNotTrack).
//   - The gtag stub queues into window.dataLayer before the script
//     arrives, so events fired early are not lost.
//
// Privacy — what NEVER leaves the device (see trackEvent/trackPageView):
//   - No room names or room ids, no user ids, no emails, no message
//     content, no URLs. The SPA URL can carry an invite token in its
//     hash (#invite-...), so page_view deliberately sends NO
//     page_location / page_path — only the coarse view name.
//   - Event params are numeric-only and allowlisted (duration_minutes,
//     occupant_count, value). Any string param is dropped, so PII
//     cannot sneak in through a caller.
//   - gtag config sets anonymize_ip and disables the automatic
//     page_view (the SPA sends its own on view/tab change).
//
// Events sent (small, fixed list):
//   page_view        { page_title: <view> }   view in
//                    rooms|friends|messages|profile|about|notifications|room
//   room_joined      {}                       user joined a room's voice session
//   room_left        {}                       user left a room's voice session
//   focus_started    { duration_minutes }     Together-mode focus timer started
//   focus_ended      {}                       Together-mode focus timer ended
//
// Pure at import time: nothing here touches window/document/navigator
// until called, so this module is unit-testable in Node. Callers pass
// an `env` ({ window, document, navigator }) only in tests; in the app
// the globals are used.

const GTAG_SCRIPT_URL = 'https://www.googletagmanager.com/gtag/js';
const GA_ID_PATTERN = /^G-[A-Z0-9]{4,}$/;

// Views the SPA tracks as page_view titles. Anything else is ignored.
const PAGE_VIEWS = new Set([
  'rooms', 'friends', 'messages', 'profile', 'about', 'notifications', 'room'
]);

// The only event names ever sent to GA4.
const ALLOWED_EVENTS = new Set(['room_joined', 'room_left', 'focus_started', 'focus_ended']);

// The only event params ever sent — numeric and coarse. Strings are
// dropped outright: a param that can hold text can hold PII.
const ALLOWED_EVENT_PARAMS = new Set(['value', 'duration_minutes', 'occupant_count']);

// Pull the Measurement ID out of the /api/config response. Returns the
// trimmed, upper-cased ID, or null when GA4 is not configured (the
// server omits the field entirely) or the value is malformed.
export const getGaMeasurementId = (config) => {
  const raw = config && typeof config.gaMeasurementId === 'string'
    ? config.gaMeasurementId.trim().toUpperCase()
    : '';
  return GA_ID_PATTERN.test(raw) ? raw : null;
};

// Do Not Track: '1' (Firefox/Chrome) or 'yes' (older Safari/IE).
// `nav`/`win` are injectable for tests; they default to the globals.
export const isDoNotTrackEnabled = (nav, win) => {
  const navigatorObj = nav !== undefined
    ? nav
    : (typeof navigator !== 'undefined' ? navigator : undefined);
  const windowObj = win !== undefined
    ? win
    : (typeof window !== 'undefined' ? window : undefined);
  const dnt = navigatorObj && (navigatorObj.doNotTrack || navigatorObj.msDoNotTrack);
  if (dnt === '1' || dnt === 'yes') return true;
  if (windowObj && (windowObj.doNotTrack === '1' || windowObj.doNotTrack === 'yes')) return true;
  return false;
};

// The single gate App.jsx uses: no ID -> no analytics; DNT -> no analytics.
export const shouldLoadAnalytics = (measurementId, nav, win) =>
  Boolean(measurementId) && !isDoNotTrackEnabled(nav, win);

const defaultEnv = () => ({
  window: typeof window !== 'undefined' ? window : undefined,
  document: typeof document !== 'undefined' ? document : undefined,
  navigator: typeof navigator !== 'undefined' ? navigator : undefined
});

let initialized = false;
let currentMeasurementId = null;
let scriptPromise = null;

// Load gtag.js for `measurementId` (already validated by the caller via
// getGaMeasurementId, re-validated here). Returns true once analytics is
// active, false when it stays a no-op (no ID, DNT set, or no DOM).
// Safe to call repeatedly — the script is only injected once.
export const initAnalytics = (measurementId, env) => {
  const id = typeof measurementId === 'string'
    ? measurementId.trim().toUpperCase()
    : '';
  if (!GA_ID_PATTERN.test(id)) return false;
  const { window: win, document: doc, navigator: nav } = env || defaultEnv();
  if (isDoNotTrackEnabled(nav, win)) return false;
  if (initialized) return true;
  if (!win || !doc || !doc.head) return false;
  win.dataLayer = win.dataLayer || [];
  if (typeof win.gtag !== 'function') {
    win.gtag = function gtag() { win.dataLayer.push(arguments); };
  }
  win.gtag('js', new Date());
  win.gtag('config', id, { anonymize_ip: true, send_page_view: false });
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.src = `${GTAG_SCRIPT_URL}?id=${id}`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromise = null;
        reject(new Error('Could not load Google Analytics'));
      };
      doc.head.appendChild(script);
    });
    // A failed load must not surface as an unhandled rejection.
    scriptPromise.catch(() => {});
  }
  initialized = true;
  currentMeasurementId = id;
  return true;
};

export const isAnalyticsEnabled = () => initialized;
export const getCurrentMeasurementId = () => currentMeasurementId;

// SPA page_view for a view/tab change. `view` must be one of PAGE_VIEWS
// ('room' is used while a room view is on screen). Sends only the view
// name — never the URL, which can carry an invite token in its hash.
// No-op (false) until initAnalytics has run.
export const trackPageView = (view, env) => {
  if (!initialized || !PAGE_VIEWS.has(view)) return false;
  const { window: win } = env || defaultEnv();
  if (!win || typeof win.gtag !== 'function') return false;
  win.gtag('event', 'page_view', { page_title: view });
  return true;
};

// One of ALLOWED_EVENTS, with numeric-only allowlisted params. Any
// string value (or unknown key) is dropped, so callers cannot pass PII
// even by accident. No-op (false) until initAnalytics has run.
export const trackEvent = (name, params, env) => {
  if (!initialized || !ALLOWED_EVENTS.has(name)) return false;
  const { window: win } = env || defaultEnv();
  if (!win || typeof win.gtag !== 'function') return false;
  const clean = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (ALLOWED_EVENT_PARAMS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      clean[key] = value;
    }
  }
  win.gtag('event', name, clean);
  return true;
};

// Test-only: reset module state between tests (fresh fake window each time).
export const resetAnalyticsForTests = () => {
  initialized = false;
  currentMeasurementId = null;
  scriptPromise = null;
};

export { GTAG_SCRIPT_URL };
