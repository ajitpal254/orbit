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
//      credentials, served by GET /api/config from the server's
//      TURN_USERNAME / TURN_CREDENTIAL env vars (see README).
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

// Full ICE server list for one RTCPeerConnection. accountTurn is the
// /api/config `turn` object ({ urls, username, credential }) or null.
export async function getIceServers(accountTurn) {
  const servers = [];
  if (accountTurn?.username && accountTurn?.credential) {
    servers.push({
      urls: accountTurn.urls,
      username: accountTurn.username,
      credential: accountTurn.credential
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
