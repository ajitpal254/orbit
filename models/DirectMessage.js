const mongoose = require('mongoose');

// 1:1 direct message between two accepted friends. Same encryption as
// room messages (AES-256-GCM via lib/crypto.js): `text` stores the
// ciphertext, so the limit is sized for the encrypted form of a
// 1000-char message (~1400). `read` tracks whether the recipient has
// opened the thread — the list view shows an unread count per friend.
const directMessageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Stored AES-256-GCM ciphertext ("iv:authTag:ciphertext" base64).
  text: { type: String, required: true, trim: true, maxlength: [2000, 'Message too long'] },
  read: { type: Boolean, default: false, index: true },
  // Fading chat: plain (unencrypted) expiry timestamp, set server-side
  // on write to createdAt + 24h. DMs fade exactly like room messages.
  // Legacy DMs have no expireAt and stay visible (grandfathered, not
  // backfilled).
  expireAt: { type: Date }
}, { timestamps: true });

// Fast conversation fetch: one friend's thread, newest first.
directMessageSchema.index({ sender: 1, recipient: 1, createdAt: -1 });

// TTL index is background storage cleanup ONLY (Mongo's TTL monitor is
// async, ~once a minute): reads exclude expired messages at query time
// via lib/fadingChat.notExpiredFilter, so expiry is visible immediately.
directMessageSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('DirectMessage', directMessageSchema);
