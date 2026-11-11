// Web Push (VAPID) — the offline half of notifications. The in-app
// center (models/Notification.js) works without this; push only fires
// when the server has VAPID keys in env. Without keys everything here
// is a silent no-op, so the app never breaks on a missing setup.
//
// Keys: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (and optional
// VAPID_SUBJECT, default mailto:orbit@example.com). The public key is
// exposed via /api/config so the frontend can subscribe; the private
// key never leaves the server. Generate a pair with
// `node -e "console.log(require('web-push').generateVAPIDKeys())"`.
const webPush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const logger = require('./logger');

const getVapidPublicKey = () => process.env.VAPID_PUBLIC_KEY || null;

const isPushConfigured = () =>
  Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

let vapidConfigured = false;
const ensureVapid = () => {
  if (vapidConfigured) return true;
  if (!isPushConfigured()) return false;
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:orbit@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  vapidConfigured = true;
  return true;
};

// Pure payload builder (unit-tested): what the push notification says.
// `tag` collapses repeats in the browser's notification tray — one
// visible push per (type, actor, room), matching the in-app dedup.
// `data.url` is the deep link the service worker opens when the push is
// tapped (see frontend/src/sw.js + frontend/src/deepLink.js): friends
// views need no id, a room invite carries its room, a DM carries the
// sender so the thread opens.
const pushPayloadFor = ({ type, actorName, actorId, roomId, roomName }) => {
  const actor = actorName || 'Someone';
  switch (type) {
    case 'friend_request':
      return { title: 'Orbit', body: `${actor} sent you a friend request`, tag: 'orbit-friend_request', data: { url: '/#friends' } };
    case 'friend_accepted':
      return { title: 'Orbit', body: `${actor} accepted your friend request`, tag: 'orbit-friend_accepted', data: { url: '/#friends' } };
    case 'room_invite':
      return { title: 'Orbit', body: `${actor} invited you to ${roomName || 'a private room'}`, tag: 'orbit-room_invite', data: { url: roomId ? `/#room-${roomId}` : '/#rooms' } };
    case 'knock':
      return { title: 'Orbit', body: `${actor} knocked on ${roomName || 'your private room'}`, tag: 'orbit-knock', data: { url: roomId ? `/#room-${roomId}` : '/#rooms' } };
    case 'dm':
      return { title: 'Orbit', body: `New message from ${actor}`, tag: 'orbit-dm', data: { url: actorId ? `/#dm-${actorId}` : '/#messages' } };
    case 'test':
      return { title: 'Orbit', body: 'This is a test notification — push is working.', tag: 'orbit-test', data: { url: '/#notifications' } };
    default:
      return { title: 'Orbit', body: 'Something happened on Orbit', tag: 'orbit', data: { url: '/' } };
  }
};

// Send a push to every subscription of one user. Best-effort by design:
// a failed send never throws — push must never break the request that
// triggered it (friend request / DM send). Subscriptions the push
// service reports as gone (410/404) are deleted so dead browsers do
// not accumulate.
const sendPushToUser = async (userId, payload) => {
  if (!ensureVapid()) return 0;
  let subs;
  try {
    subs = await PushSubscription.find({ user: userId }).lean();
  } catch (err) {
    logger.warn({ err }, 'Push subscription lookup failed');
    return 0;
  }
  let sent = 0;
  for (const sub of subs) {
    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify({ ...payload, data: payload.data || {} })
      );
      sent += 1;
    } catch (err) {
      // 410 Gone / 404 Not Found: the browser uninstalled or the
      // subscription expired — prune it. Anything else (network,
      // 5xx) is transient; leave the row for next time.
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        try { await PushSubscription.deleteOne({ _id: sub._id }); } catch {}
      } else {
        logger.warn({ err: err && err.message }, 'Web push send failed');
      }
    }
  }
  return sent;
};

module.exports = { getVapidPublicKey, isPushConfigured, pushPayloadFor, sendPushToUser };
