// Persistent notifications: create-or-bump (dedup) + serialization.
// Pure helpers are unit-tested in tests/notifications.test.js; the
// record function needs MongoDB and is exercised by the routes.
//
// Dedup rule: at most one UNREAD notification per (user, type, actor,
// room). A repeat event bumps the existing row's updatedAt instead of
// creating a duplicate — for DMs that means one unread row per friend
// no matter how many messages they send, and a re-sent invite does not
// spam the list either. Read rows never dedup: once you have seen one,
// a new event starts a fresh row.
const Notification = require('../models/Notification');
const logger = require('./logger');
const { pushPayloadFor, sendPushToUser } = require('./push');

// Pure: the Mongo query that finds the unread duplicate of an event.
const dedupQuery = ({ userId, type, actorId, roomId }) => ({
  user: userId,
  type,
  actor: actorId,
  room: roomId || null,
  read: false
});

// Pure: the one-line text shown in the Notifications view (and in the
// push body). Actor/room names are resolved by the caller.
const notificationText = ({ type, actorName, roomName }) => {
  const actor = actorName || 'Someone';
  switch (type) {
    case 'friend_request': return `${actor} sent you a friend request`;
    case 'friend_accepted': return `${actor} accepted your friend request`;
    case 'room_invite': return `${actor} invited you to ${roomName || 'a private room'}`;
    case 'dm': return `New message from ${actor}`;
    case 'test': return 'Test notification — push is working';
    default: return 'Something happened on Orbit';
  }
};

// Serialize one notification with its actor (+ room) resolved to the
// shapes the frontend needs. actor/room are plain objects (or null)
// looked up by the route — this function only shapes them.
const notificationJson = (n, actor, room) => ({
  id: String(n._id),
  type: n.type,
  actor: actor
    ? {
        id: String(actor._id),
        name: actor.name || '',
        avatarPreset: actor.avatarPreset || null,
        avatarImage: actor.avatarImage || ''
      }
    : null,
  room: room ? { id: String(room._id), name: room.name || '' } : null,
  read: !!n.read,
  text: notificationText({
    type: n.type,
    actorName: actor ? actor.name : null,
    roomName: room ? room.name : null
  }),
  createdAt: n.createdAt,
  updatedAt: n.updatedAt
});

// Record an event for a user: upsert by the dedup rule, then fire a
// web push (best-effort). Never throws: notification creation is
// secondary to the action that triggered it (friend request / DM /
// invite), and a failure here must not turn that action into a 500.
// Returns { notification, created } or null when the write failed.
const recordNotification = async ({ userId, type, actorId, actorName, roomId, roomName }) => {
  try {
    const existing = await Notification.findOne(
      dedupQuery({ userId, type, actorId, roomId })
    );
    if (existing) {
      // Bump: the row is still the one unread item for this event, but
      // its updatedAt now reflects the latest occurrence, so the list
      // sorts it as new.
      existing.updatedAt = new Date();
      await existing.save();
      return { notification: existing, created: false };
    }
    const notification = await Notification.create({
      user: userId, type, actor: actorId, room: roomId || null, read: false
    });
    // Push is fire-and-forget inside recordNotification — sendPushToUser
    // never throws, so a missing VAPID setup or a dead subscription
    // cannot break the caller. actorId/roomId ride along so the push
    // deep-links to the right room / DM thread (see lib/push.js).
    const payload = pushPayloadFor({ type, actorName, actorId, roomId, roomName });
    sendPushToUser(userId, payload).catch(() => {});
    return { notification, created: true };
  } catch (err) {
    logger.warn({ err }, 'recordNotification failed');
    return null;
  }
};

module.exports = { dedupQuery, notificationText, notificationJson, recordNotification };
