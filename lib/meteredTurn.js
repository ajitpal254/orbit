// Metered REST API TURN credentials (replaces the self-minted HMAC path).
//
// Why this module exists: since v0.5.1 the server minted TURN
// credentials itself with HMAC-SHA1(TURN_SECRET, username) and served
// them from GET /api/turn. Metered's relay REJECTS those credentials:
// Metered only accepts credentials it issues itself. Metered's docs
// (https://www.metered.ca/docs/turn-rest-api/post-create-credential/)
// say credentials are created by POSTing to
// https://<appname>.metered.live/api/v1/turn/credential?secretKey=<key>,
// and an independent test showed global.relay.metered.ca answering a
// protocol-level TURN Allocate error (400) for the self-minted scheme.
// The result: clients gathered only host+srflx candidates and ICE
// failed wherever the direct path fails
// ("failed / disconnected (host+srflx)", no relay candidate ever).
//
// This module mints ONE credential from Metered's REST API, caches it,
// and serves the cached credential from GET /api/turn. Two constraints
// from the docs drive the design:
//   - A newly created credential takes UP TO 2 MINUTES to propagate
//     across Metered's global network and is not usable immediately,
//     so credentials are created ahead of time and reused across calls.
//   - So the cached credential is refreshed when <2h of validity is
//     left, and once at boot — the fresh credential then has hours to
//     propagate before the old one expires.
// On mint failure the last valid cached credential keeps being served;
// with no valid cached credential the handler answers { turn: null }
// and the client falls back to STUN + the built-in relays, as before.
// The credential is shared by every authenticated user (Metered
// credentials are account-level, not per-user) — session auth on
// GET /api/turn still gates it, so random internet users cannot fetch
// it (audit H2).
//
// The secret key is never logged and never leaves the server: it is
// only ever sent to Metered's API as a query parameter, and the pino
// redact list (lib/logger.js) redacts credential-shaped fields as a
// backstop. It reaches the server only via env vars:
//   METERED_SECRET_KEY — Metered dashboard → Developers → Secret Key.
//   METERED_APP_DOMAIN — the "<appname>.metered.live" host.

const { turnUrls } = require('./turnCredentials');

const METERED_EXPIRY_SECONDS = 86400; // 24h credentials
const METERED_LABEL = 'orbit';
const REFRESH_WHEN_REMAINING_MS = 2 * 60 * 60 * 1000; // refresh when <2h left
const MINT_TIMEOUT_MS = 15000;

// Normalize METERED_APP_DOMAIN: the expected format is the
// "<appname>.metered.live" host. Accept with or without a scheme and
// with or without a trailing slash/path — "https://myapp.metered.live/"
// and "myapp.metered.live" both become "myapp.metered.live".
// Returns the host, or null when nothing usable remains.
const normalizeAppDomain = (raw) => {
  if (typeof raw !== 'string') return null;
  let host = raw.trim();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  host = host.split('/')[0].trim();
  return host || null;
};

const meteredConfig = (env = process.env) => {
  const secretKey = typeof env.METERED_SECRET_KEY === 'string' ? env.METERED_SECRET_KEY.trim() : '';
  return { secretKey: secretKey || null, appDomain: normalizeAppDomain(env.METERED_APP_DOMAIN) };
};

const isMeteredTurnConfigured = (env = process.env) => {
  const { secretKey, appDomain } = meteredConfig(env);
  return Boolean(secretKey && appDomain);
};

// Mint one credential from Metered's REST API. Returns
// { username, password, expiryInSeconds, mintedAtMs } or null on any
// failure (network error, non-2xx, invalid JSON, incomplete credential).
// `fetchImpl` is injectable so tests can mock it without network;
// production passes none and the global fetch is used. Never logs the
// secret key or the minted password — only the host and the HTTP status.
const mintMeteredCredential = async ({
  secretKey,
  appDomain,
  fetchImpl,
  expirySeconds = METERED_EXPIRY_SECONDS,
  log,
  nowMs = Date.now()
} = {}) => {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;
  // The secret key travels as a query parameter (Metered's API design).
  // Never log this URL.
  const url = `https://${appDomain}/api/v1/turn/credential?secretKey=${encodeURIComponent(secretKey)}`;
  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiryInSeconds: expirySeconds, label: METERED_LABEL }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS)
    });
  } catch (err) {
    log?.warn?.({ err: err?.name || 'fetch-error', appDomain }, 'Metered TURN credential mint failed (network) — keeping the cached credential');
    return null;
  }
  if (!res.ok) {
    log?.warn?.({ status: res.status, appDomain }, 'Metered TURN credential mint failed — keeping the cached credential');
    return null;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    log?.warn?.({ appDomain }, 'Metered TURN credential mint returned invalid JSON — keeping the cached credential');
    return null;
  }
  if (!data || typeof data.username !== 'string' || !data.username
    || typeof data.password !== 'string' || !data.password) {
    log?.warn?.({ appDomain }, 'Metered TURN credential mint returned an incomplete credential — keeping the cached credential');
    return null;
  }
  const ttl = Number.isFinite(data.expiryInSeconds) && data.expiryInSeconds > 0
    ? data.expiryInSeconds
    : expirySeconds;
  return { username: data.username, password: data.password, expiryInSeconds: ttl, mintedAtMs: nowMs };
};

// One cached credential, shared by every caller until it is refreshed.
// getTurn() serves the cached credential while it has more than
// REFRESH_WHEN_REMAINING_MS left, refreshes it in the background once
// it drops below that, and mints synchronously only when there is no
// usable cached credential at all. Concurrent mints are deduped through
// a single in-flight promise, and a mint never throws: a failure keeps
// the old cached credential (or yields null when there is none).
const createMeteredTurn = ({
  fetchImpl,
  env = process.env,
  log = null,
  nowFn = () => Date.now(),
  expirySeconds = METERED_EXPIRY_SECONDS,
  refreshThresholdMs = REFRESH_WHEN_REMAINING_MS
} = {}) => {
  let cached = null; // { username, password, expiresAtMs, mintedAtMs }
  let mintPromise = null;
  let refreshTimer = null;

  const clearTimer = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };

  const scheduleRefresh = () => {
    clearTimer();
    if (!cached) return;
    const delay = Math.max(0, cached.expiresAtMs - nowFn() - refreshThresholdMs);
    refreshTimer = setTimeout(() => { void refreshInBackground(); }, delay);
    // Never hold the process open for a background refresh (tests, and
    // a server that is otherwise idle).
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  };

  const mintAndCache = async () => {
    try {
      const { secretKey, appDomain } = meteredConfig(env);
      if (!secretKey || !appDomain) return null;
      const minted = await mintMeteredCredential({ secretKey, appDomain, fetchImpl, expirySeconds, log, nowMs: nowFn() });
      if (!minted) return null;
      cached = {
        username: minted.username,
        password: minted.password,
        expiresAtMs: minted.mintedAtMs + minted.expiryInSeconds * 1000,
        mintedAtMs: minted.mintedAtMs
      };
      scheduleRefresh();
      log?.info?.({ appDomain, expiryInSeconds: minted.expiryInSeconds }, 'Metered TURN credential minted');
      return cached;
    } catch {
      return null;
    }
  };

  const mintOnce = () => {
    if (!mintPromise) mintPromise = mintAndCache().finally(() => { mintPromise = null; });
    return mintPromise;
  };

  const refreshInBackground = () => {
    // Fire-and-forget: mintOnce never rejects, and a failed refresh
    // leaves the still-valid cached credential in place. The next
    // getTurn() call retries while the remaining validity is low.
    void mintOnce();
  };

  const toTurn = (entry) => ({ urls: turnUrls(env), username: entry.username, credential: entry.password });

  return {
    isConfigured: () => isMeteredTurnConfigured(env),

    // Serve the cached credential, minting synchronously only when
    // there is no usable one. Returns { urls, username, credential }
    // or null when unconfigured / no credential could be minted.
    getTurn: async () => {
      if (!isMeteredTurnConfigured(env)) return null;
      const now = nowFn();
      if (cached && cached.expiresAtMs > now) {
        if (cached.expiresAtMs - now <= refreshThresholdMs) refreshInBackground();
        return toTurn(cached);
      }
      const fresh = await mintOnce();
      return fresh ? toTurn(fresh) : null;
    },

    // Mint once at boot so the credential has propagated long before
    // the first call (Metered: up to 2 min). Fire-and-forget from
    // server.js: a failure only logs, and the first /api/turn call
    // mints synchronously instead. Never throws. A usable cached
    // credential makes this a no-op (idempotent across restarts of
    // the boot sequence in tests).
    init: async () => {
      if (!isMeteredTurnConfigured(env)) return;
      if (cached && cached.expiresAtMs > nowFn()) return;
      await mintOnce();
    },

    // Stop the scheduled background refresh (tests / shutdown).
    stop: () => { clearTimer(); },

    // Test/support only: drop the cached credential and any scheduled
    // refresh so the next getTurn() mints again.
    reset: () => {
      clearTimer();
      cached = null;
      mintPromise = null;
    }
  };
};

// Loud boot warning when the account relay is not configured. Called
// from server.js at boot (not at import time, so tests stay quiet).
const warnIfMeteredTurnMissing = (log, env = process.env) => {
  if (!isMeteredTurnConfigured(env)) {
    log.warn(
      'METERED_SECRET_KEY / METERED_APP_DOMAIN are not set — the account TURN relay is disabled; voice will use STUN + the built-in fallback relays only. Set both on Render to enable it (Metered dashboard → Developers → Secret Key; the app domain is <appname>.metered.live).'
    );
  }
};

// The shared instance: configured from process.env, global fetch, the
// app logger. Created at require time; nothing is minted until init()
// or the first getTurn() call, so requiring this module is side-effect
// free in tests.
const meteredTurn = createMeteredTurn({ log: require('./logger') });

// Express handler for GET /api/turn (session-authenticated; wired in
// routes/api.js). Answers { turn: { urls, username, credential } } when
// a Metered credential is available, { turn: null } when unconfigured
// or no credential could be minted — never a static credential, never
// a 500 for "not configured". The credential here is the `password`
// Metered issued (not a self-minted HMAC — that path is gone).
const turnHandler = async (req, res) => {
  const turn = await meteredTurn.getTurn();
  res.json({ turn });
};

module.exports = {
  METERED_EXPIRY_SECONDS,
  METERED_LABEL,
  REFRESH_WHEN_REMAINING_MS,
  MINT_TIMEOUT_MS,
  normalizeAppDomain,
  meteredConfig,
  isMeteredTurnConfigured,
  mintMeteredCredential,
  createMeteredTurn,
  warnIfMeteredTurnMissing,
  meteredTurn,
  turnHandler
};
