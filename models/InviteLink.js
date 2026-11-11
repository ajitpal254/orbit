const mongoose = require('mongoose');

// A shareable join link for a room. One active link per room.
//
// The token itself is never stored — only its SHA-256 hash
// (lib/passwords.js hashToken, same as session tokens), so a database
// read alone cannot redeem a link. Tokens are crypto-random, never
// sequential or derived from the room id (see lib/inviteLinks.js).
//
// expiresAt is server-set at creation: 7 days out for private rooms,
// null (never expires) for public rooms. Expiry is enforced in the
// join path at read time; the TTL index below is only eventual storage
// cleanup (same pattern as fading chat) and ignores null expiresAt.
//
// Revocation deletes the row — a revoked link is simply gone, so it
// can never be redeemed again. Creating a link when one already exists
// returns the existing one instead of duplicating it.
const inviteLinkSchema = new mongoose.Schema({
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, unique: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, default: null, index: true }
}, { timestamps: true });

// Expired private-room links are removed by MongoDB's TTL monitor.
// expireAfterSeconds: 0 means "at expiresAt". Docs with expiresAt null
// (public-room links) are never removed by this index.
inviteLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('InviteLink', inviteLinkSchema);
