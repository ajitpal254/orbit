// TURN relay URLs (public — they name a host, nothing more).
//
// This module used to mint TURN credentials itself with
// HMAC-SHA1(TURN_SECRET, username) and serve them from GET /api/turn.
// That path is gone: Metered's relay rejects self-minted credentials
// (it only accepts credentials it issues via its REST API), so since
// v0.5.1 no account TURN credential was ever accepted and clients
// gathered only host+srflx candidates. Credentials are now minted by
// lib/meteredTurn.js (Metered REST API, cached, refreshed ahead of
// expiry) and served from GET /api/turn; this module keeps only the
// relay URL list, which GET /api/config still serves publicly.

const DEFAULT_TURN_URLS =
  'turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:443,turn:standard.relay.metered.ca:443?transport=tcp';

// The TURN server URLs (public — not a secret). Overridable with
// TURN_URLS, comma-separated; defaults to the Metered standard relay.
const turnUrls = (env = process.env) =>
  (env.TURN_URLS || DEFAULT_TURN_URLS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

module.exports = {
  DEFAULT_TURN_URLS,
  turnUrls
};
