const mongoose = require('mongoose');

// One row per thing a user should be told about — the persistent half
// of notifications. The live half is the socket push (friend-request /
// room-invite / friend-accepted / dm-message in lib/socket.js and
// routes/api.js); this model is what the bell + Notifications view
// read, so offline users see everything on their next load.
//
// Dedup (see lib/notifications.js): at most one UNREAD notification per
// (user, type, actor, room) — a repeat event bumps the existing row's
// updatedAt instead of creating a duplicate. For DMs that means one
// unread row per friend no matter how many messages they send; the row
// is cleared by opening the thread (which also marks the DMs read).
const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: {
    type: String,
    enum: ['friend_request', 'friend_accepted', 'room_invite', 'dm'],
    required: true,
    index: true
  },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null, index: true },
  read: { type: Boolean, default: false, index: true }
}, { timestamps: true });

// Fast list fetch: my notifications, unread first, newest first.
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
