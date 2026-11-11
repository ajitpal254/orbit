const mongoose = require('mongoose');

// A knock on a private room: a non-member asks to be let in. The
// room's owner/moderators are notified (persistent Notification +
// push + live socket, see routes/api.js) and admit or decline.
//
// One row per (room, user) — a repeat knock while one is pending
// returns the existing row instead of a second one, and a previously
// declined knock is reopened rather than violating the unique index
// (same pattern as RoomInvite). A knock that is admitted means the
// user is a member, so the member check rejects any further knock.
//
// Unanswered knocks expire after 24h (lib/knock.js KNOCK_TTL_MS):
// the TTL index deletes the row from storage, and the routes also
// filter expired knocks at read time, so an expired knock is never
// listed or answerable even before the TTL sweep runs.
const knockSchema = new mongoose.Schema({
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'admitted', 'declined'], default: 'pending', index: true },
  expiresAt: { type: Date, default: null }
}, { timestamps: true });

knockSchema.index({ room: 1, user: 1 }, { unique: true });
// TTL: expireAfterSeconds 0 means "at expiresAt". Rows with a null
// expiresAt are ignored by the TTL monitor, so a missing deadline
// never deletes anything.
knockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Knock', knockSchema);
