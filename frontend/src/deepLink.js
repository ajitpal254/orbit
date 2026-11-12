// Pure: parse a push deep-link hash into the view it should open.
// Hashes the service worker uses (see lib/push.js data.url):
//   #friends, #notifications, #messages, #rooms,
//   #room-<roomId>, #dm-<userId>
// Plus invite links, shared as a URL by a room member:
//   #invite-<token>
// Plus email-verification links (see lib/emailVerification.js):
//   #verify-email-<token>
// Anything else returns null (the app opens normally).
//
// Invite and verification links live in the hash (not the path or
// query) so the token never travels in an HTTP request line or a
// server log — App.jsx reads the hash and redeems the token with a
// POST body instead.
export function parseDeepLinkHash(hash) {
  if (typeof hash !== 'string') return null;
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (h === 'friends' || h === 'notifications' || h === 'messages' || h === 'rooms') {
    return { view: h };
  }
  if (h.startsWith('room-') && h.length > 5) return { view: 'rooms', roomId: h.slice(5) };
  if (h.startsWith('dm-') && h.length > 3) return { view: 'messages', dmUserId: h.slice(3) };
  if (h.startsWith('invite-') && h.length > 7) {
    // The token's shape is the server's call (it answers 404 for a
    // malformed one, and App shows the friendly error) — any
    // non-empty token parses here so a mistyped link still explains
    // itself instead of being silently ignored.
    return { view: 'rooms', inviteToken: h.slice(7) };
  }
  if (h.startsWith('verify-email-') && h.length > 13) {
    // Same shape rule as invite links: any non-empty token parses
    // so a bad link explains itself via the verify endpoint's 400.
    return { view: 'rooms', verifyEmailToken: h.slice(13) };
  }
  return null;
}

// The shareable invite-link URL for a token: the app's origin plus the
// #invite- hash. `origin` is window.location.origin on the client.
export function buildInviteLinkUrl(origin, token) {
  const base = typeof origin === 'string' ? origin.replace(/\/+$/, '') : '';
  return `${base}/#invite-${token}`;
}
