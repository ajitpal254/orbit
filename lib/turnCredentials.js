// Time-limited TURN credentials, minted server-side (audit H2).
//
// The old design served the account's static TURN username/credential to
// anyone who asked GET /api/config — no auth — so anyone on the internet
// could burn the relay quota. The static credential is never shipped to
// clients anymore. Instead the server mints short-lived credentials per
// user with the TURN REST API / coturn static-auth scheme:
//
//   username   = "<expiryUnixSeconds>:<userId>"
//   credential = base64(HMAC-SHA1(TURN_SECRET, username))
//
// This is the exact pattern the frontend already implements for the
// no-signup fallback relay (frontend/src/turnAuth.js: computeTurnCredential
// + staticAuthUsername, 24h expiry) — moved server-side with a secret
// only the server holds (Render env var TURN_SECRET). The relay verifies
// the credential itself, so no session state is needed server-side.
//
// When TURN_SECRET is unset the account TURN is simply unavailable:
// mintTurnCredentials returns null, GET /api/turn answers { turn: null },
// and the client keeps working with STUN + the built-in fallback relays.
// server.js logs a loud boot warning in that case — set TURN_SECRET on
// Render to enable the account relay.
const crypto = require('crypto');

const TURN_TTL_SECONDS = 86400; // 24h, same as the static-auth fallback
const DEFAULT_TURN_URLS =
  'turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:443,turn:standard.relay.metered.ca:443?transport=tcp';

// The TURN server URLs (public — not a secret). Overridable with
// TURN_URLS, comma-separated; defaults to the Metered standard relay.
const turnUrls = (env = process.env) =>
  (env.TURN_URLS || DEFAULT_TURN_URLS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const isTurnConfigured = (secret = process.env.TURN_SECRET) => Boolean(secret);

// Mint one time-limited credential for a user. Returns
// { urls, username, credential } or null when TURN_SECRET is unset.
// `nowSeconds` exists so tests can pin the clock; production passes none.
const mintTurnCredentials = (userId, secret = process.env.TURN_SECRET, nowSeconds = Math.floor(Date.now() / 1000)) => {
  if (!secret) return null;
  const expiry = nowSeconds + TURN_TTL_SECONDS;
  const username = `${expiry}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { urls: turnUrls(), username, credential };
};

// Verify a minted credential against the secret (independent check used
// by tests; the TURN server itself does this verification at allocate
// time). Constant-time compare so a wrong credential does not leak
// timing.
const verifyTurnCredential = (username, credential, secret) => {
  if (typeof username !== 'string' || typeof credential !== 'string' || !secret) return false;
  const expected = crypto.createHmac('sha1', secret).update(username).digest('base64');
  const a = Buffer.from(credential);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

// Loud boot warning when the account relay is not configured. Called
// from server.js at boot (not at import time, so tests stay quiet).
const warnIfTurnSecretMissing = (log) => {
  if (!isTurnConfigured()) {
    log.warn(
      'TURN_SECRET is not set — the account TURN relay is disabled; voice will use STUN + the built-in fallback relays only. Set TURN_SECRET on Render to enable it.'
    );
  }
};

// Express handler for GET /api/turn (session-authenticated; wired in
// routes/api.js). Answers { turn: { urls, username, credential } } when
// configured, { turn: null } when TURN_SECRET is unset — never a static
// credential, never a 500 for "not configured".
const turnHandler = (req, res) => {
  const turn = mintTurnCredentials(String(req.user._id));
  res.json({ turn });
};

module.exports = {
  TURN_TTL_SECONDS,
  DEFAULT_TURN_URLS,
  turnUrls,
  isTurnConfigured,
  mintTurnCredentials,
  verifyTurnCredential,
  warnIfTurnSecretMissing,
  turnHandler
};
