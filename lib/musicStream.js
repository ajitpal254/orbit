// Same-origin audio proxy for the music bot (v0.10.0).
//
// Why this exists: the DJ's browser plays the track in a hidden
// <audio> element and hands captureStream() to the voice engine —
// but captureStream() throws a SecurityError ("Cannot capture from
// element with cross-origin data") for ANY cross-origin media, and
// radio / YouTube stream URLs are always cross-origin. So the DJ
// never loads the raw URL: the element loads /api/music/stream?u=<url>
// (same-origin), and the server fetches the bytes upstream.
// Proven in headless Chromium 2026-11-15: same-origin captureStream
// returns a live track; cross-origin throws SecurityError — the
// "captureStream avoids CORS" assumption in the original v0.10.0
// brief was wrong, and this proxy is the fix.
//
// Safety (this endpoint fetches a user-supplied URL):
// - http(s) only; the hostname must not be localhost / private /
//   loopback — checked on the literal host AND on the DNS answer
//   (same SSRF rules as lib/unfurl.js, so a public-looking name that
//   resolves privately is refused). Redirects are followed manually
//   (max 3) with the SAME check re-run on every hop, so a 302 to an
//   internal address cannot smuggle a fetch past the guard.
// - ALLOW_PRIVATE_STREAM_HOSTS=1 lifts the private-host block for
//   tests only (the smoke fixture is a local HTTP server); never set
//   it in production.
// - The upstream URL is NEVER logged (a resolved YouTube URL carries
//   a signature) — failures log only the host + a coarse reason. The
//   access log is safe too: requestLog logs the matched route
//   pattern, never the query string.
// - 10s timeout to first byte (a live radio stream legitimately
//   never ends, so the timeout covers connect + headers only, not
//   the whole body); Range is forwarded so the <audio> element's
//   seeks work; the body is streamed, never buffered.

const dns = require('dns');
const { isBlockedHost, isPrivateIp } = require('./unfurl');
const logger = require('./logger');

const MUSIC_STREAM_TIMEOUT_MS = 10_000;
const MUSIC_STREAM_MAX_URL_LENGTH = 2048;
const MUSIC_STREAM_MAX_REDIRECTS = 3;

// Test-only escape hatch: the smoke fixture is a local HTTP server,
// so the smoke test boots the server with ALLOW_PRIVATE_STREAM_HOSTS=1.
// Never set in production — the SSRF guard stays on there.
const privateHostsAllowed = () => process.env.ALLOW_PRIVATE_STREAM_HOSTS === '1';

// Validate a user-supplied audio URL for proxying. Returns
// { ok: true, url } (normalized) or { ok: false, error }
// ('INVALID_URL' | 'BLOCKED_HOST'). `dnsImpl` is injectable so
// tests can stub the DNS answer; `log` is injectable so tests can
// assert the URL never appears in logs (only the host is logged).
const validateStreamUrl = async (rawUrl, { dnsImpl, log = logger } = {}) => {
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > MUSIC_STREAM_MAX_URL_LENGTH) {
    return { ok: false, error: 'INVALID_URL' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'INVALID_URL' };
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    return { ok: false, error: 'INVALID_URL' };
  }
  // Node keeps IPv6 brackets in URL.hostname ('[::1]'), which
  // net.isIP rejects — strip them before the block check, or ::1
  // slips through as a "public" name.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!privateHostsAllowed()) {
    if (isBlockedHost(host)) {
      log?.warn?.({ host }, 'Stream URL blocked (private host)');
      return { ok: false, error: 'BLOCKED_HOST' };
    }
    try {
      const lookup = dnsImpl || ((h) => dns.promises.lookup(h, { all: true }));
      const answers = await lookup(host);
      const list = Array.isArray(answers) ? answers : [answers];
      if (list.some((a) => a && isPrivateIp(a.address || a))) {
        log?.warn?.({ host }, 'Stream URL blocked (DNS resolves privately)');
        return { ok: false, error: 'BLOCKED_HOST' };
      }
    } catch {
      return { ok: false, error: 'BLOCKED_HOST' }; // unresolvable host: refuse, don't fetch
    }
  }
  return { ok: true, url: parsed.toString() };
};

class StreamUnavailableError extends Error {
  constructor(reason) {
    super(`Audio stream unavailable: ${reason}`);
    this.code = 'STREAM_UNAVAILABLE';
    this.reason = reason;
  }
}

// Fetch the upstream audio and return the fetch Response (body not
// yet consumed — the caller streams it). `fetchImpl` is injectable
// so tests can stub the network; `range` is forwarded verbatim;
// `signal` lets the caller abort (timeout / client disconnect).
// Redirects are followed manually (max 3) with validateStreamUrl
// re-run on every hop, so a 302 cannot smuggle a private fetch.
const fetchUpstream = async (
  url,
  { fetchImpl, range, signal, dnsImpl, log, maxRedirects = MUSIC_STREAM_MAX_REDIRECTS } = {}
) => {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new StreamUnavailableError('no-fetch');
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res;
    try {
      res = await fetchFn(current, {
        signal,
        redirect: 'manual',
        headers: {
          ...(range ? { range } : {}),
          'user-agent': 'OrbitMusic/1.0 (+https://orbit-3lzs.onrender.com/)',
          accept: 'audio/*,*/*;q=0.1'
        }
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new StreamUnavailableError('aborted');
      throw new StreamUnavailableError('fetch-failed');
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers?.get?.('location');
      if (!location) throw new StreamUnavailableError(`upstream-${res.status}`);
      let next;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new StreamUnavailableError('bad-redirect');
      }
      const check = await validateStreamUrl(next, { dnsImpl, log });
      if (!check.ok) throw new StreamUnavailableError('redirect-blocked');
      current = check.url;
      continue;
    }
    if (!res.ok) throw new StreamUnavailableError(`upstream-${res.status}`);
    return res;
  }
  throw new StreamUnavailableError('too-many-redirects');
};

module.exports = {
  MUSIC_STREAM_TIMEOUT_MS,
  MUSIC_STREAM_MAX_URL_LENGTH,
  MUSIC_STREAM_MAX_REDIRECTS,
  validateStreamUrl,
  fetchUpstream,
  StreamUnavailableError
};
