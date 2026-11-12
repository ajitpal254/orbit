// TURN servers for the mesh voice engine (frontend/src/voice.js).
//
// Why TURN matters: STUN alone only lets two peers connect directly.
// On networks where a direct path fails (same-WiFi AP isolation, symmetric
// NAT, mobile carriers), ICE can only complete through a TURN relay —
// without one the connection sits at "checking" and then fails, which is
// exactly what the status line showed ("failed / disconnected (host+srflx)"
// with no relay candidate ever gathered).
//
// Two TURN sources, in order:
//   1. Account TURN (reliable): a free Metered.ca account's TURN
//      relay. The server mints a 24h credential via Metered's REST API
//      and caches it (see lib/meteredTurn.js), serving it from the
//      session-authenticated GET /api/turn; the static account
//      credential is never shipped to clients (audit H2). The
//      /api/config `turn` object carries only the relay URLs now, so
//      getIceServers fetches the credential from /api/turn whenever
//      the object it was handed has none — voice.js itself is owned
//      by the H1 work and is not touched here.
//   2. Static-auth TURN (no signup, best-effort): Metered's Open Relay
//      static endpoint. The old copy-pasted public credentials
//      (openrelayproject / openrelayproject) are stale and no longer
//      allocate — the endpoint now uses coturn static auth: the client
//      computes a time-limited credential, username "<expiry>:label" and
//      credential base64(HMAC-SHA1(secret, username)), with the public
//      shared secret below (documented by Metered; it is not a private
//      key, it only mints 24h relay credentials).
//   3. freeturn.net (no signup, best-effort): a second public TURN with
//      documented public credentials (free / free), added because the
//      static-auth endpoint's liveness cannot be verified from the
//      sandbox (its egress proxy drops STUN traffic) — a dead server
//      simply yields no relay candidates and costs nothing.
// Google STUN is always last (direct paths first).

const STATIC_AUTH_SECRET = 'openrelayprojectsecret';
const STATIC_AUTH_HOST = 'staticauth.openrelay.metered.ca';
const STATIC_AUTH_TTL_SECONDS = 86400; // 24h credentials

export const FALLBACK_ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

// HMAC-SHA1(secret, username), base64-encoded. Uses WebCrypto; returns
// null where it is unavailable (non-secure contexts, old runtimes).
export async function computeTurnCredential(username, secret = STATIC_AUTH_SECRET) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await subtle.sign('HMAC', key, enc.encode(username));
  return bytesToBase64(new Uint8Array(sig));
}

export function staticAuthUsername(nowSeconds = Math.floor(Date.now() / 1000)) {
  return `${nowSeconds + STATIC_AUTH_TTL_SECONDS}:openrelayproject`;
}

let cachedStatic = null; // { servers, expiresAt }

export async function getStaticAuthServers() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedStatic && cachedStatic.expiresAt > now + 3600) return cachedStatic.servers;
  const username = staticAuthUsername(now);
  const credential = await computeTurnCredential(username);
  if (!credential) return [];
  const servers = [
    { urls: `turn:${STATIC_AUTH_HOST}:80`, username, credential },
    { urls: `turn:${STATIC_AUTH_HOST}:443`, username, credential },
    { urls: `turn:${STATIC_AUTH_HOST}:443?transport=tcp`, username, credential }
  ];
  cachedStatic = { servers, expiresAt: now + STATIC_AUTH_TTL_SECONDS };
  return servers;
}

// Account TURN from the server: GET /api/turn mints a time-limited
// credential for the signed-in user (session cookie, no CSRF needed —
// GET). Returns the { urls, username, credential } object, or null
// when the account relay is not configured (METERED_SECRET_KEY /
// METERED_APP_DOMAIN unset),
// the user is signed out, or the request fails. Never throws — the
// caller falls through to the fallback relays.
export async function getAccountTurn() {
  try {
    if (typeof fetch !== 'function') return null;
    const res = await fetch('/api/turn', { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const turn = data && data.turn;
    if (turn && turn.username && turn.credential) return turn;
    return null;
  } catch {
    return null;
  }
}

// Full ICE server list for one RTCPeerConnection. accountTurn is the
// /api/config `turn` object ({ urls, username, credential }) or null.
//
// The /api/config object no longer carries credentials (audit H2), so
// when the object handed in has URLs but no username/credential — or
// nothing was handed in at all — the account credential is fetched
// from GET /api/turn. An object that already carries a
// username/credential is used as-is (keeps the unit tests honest and
// lets a caller pass a minted credential directly).
export async function getIceServers(accountTurn) {
  const servers = [];
  let account = accountTurn;
  if (!account?.username || !account?.credential) {
    account = await getAccountTurn();
  }
  if (account?.username && account?.credential) {
    servers.push({
      urls: account.urls,
      username: account.username,
      credential: account.credential
    });
  }
  servers.push(...(await getStaticAuthServers()));
  // freeturn.net: public TURN, documented credentials free / free.
  // UDP first, then TCP, then TLS — whichever the network allows.
  servers.push(
    { urls: 'turn:freeturn.net:3478', username: 'free', credential: 'free' },
    { urls: 'turn:freeturn.net:3478?transport=tcp', username: 'free', credential: 'free' },
    { urls: 'turns:freeturn.net:5349', username: 'free', credential: 'free' }
  );
  servers.push(...FALLBACK_ICE_SERVERS);
  return servers;
}
