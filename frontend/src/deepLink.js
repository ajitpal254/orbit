// Pure: parse a push deep-link hash into the view it should open.
// Hashes the service worker uses (see lib/push.js data.url):
//   #friends, #notifications, #messages, #rooms,
//   #room-<roomId>, #dm-<userId>
// Anything else returns null (the app opens normally).
export function parseDeepLinkHash(hash) {
  if (typeof hash !== 'string') return null;
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (h === 'friends' || h === 'notifications' || h === 'messages' || h === 'rooms') {
    return { view: h };
  }
  if (h.startsWith('room-') && h.length > 5) return { view: 'rooms', roomId: h.slice(5) };
  if (h.startsWith('dm-') && h.length > 3) return { view: 'messages', dmUserId: h.slice(3) };
  return null;
}
