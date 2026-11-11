const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, trim: true, maxlength: [60, 'Name too long'], default: '' },
  // Stored AES-256-GCM ciphertext ("iv:authTag:ciphertext" base64), so the
  // limit is sized for the encrypted form of a 1000-char message (~1400).
  text: { type: String, required: true, trim: true, maxlength: [2000, 'Message too long'] },
  // Fading chat: plain (unencrypted) expiry timestamp, set server-side
  // on write to createdAt + 24h. Legacy messages have no expireAt and
  // stay visible (grandfathered, not backfilled).
  expireAt: { type: Date }
}, { timestamps: true });

// Fast history fetch: latest messages per room, newest first.
messageSchema.index({ roomId: 1, createdAt: -1 });

// TTL index is background storage cleanup ONLY (Mongo's TTL monitor is
// async, ~once a minute): reads exclude expired messages at query time
// via lib/fadingChat.notExpiredFilter, so expiry is visible immediately.
messageSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Message', messageSchema);
