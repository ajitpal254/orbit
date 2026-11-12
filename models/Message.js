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
  expireAt: { type: Date },
  // Optional image attachment (media sharing, v0.8.0). The URL is
  // always our own /api/media/<fileId> GridFS endpoint — never a
  // remote URL (see lib/media.validateMediaField). The file's own
  // expiry is re-stamped to this message's expireAt when the message
  // is created, so the image fades exactly when the message does.
  // Plain metadata only (URL, size, filename for alt text): no
  // content is encrypted here, and nothing sensitive is stored.
  media: {
    url: { type: String, maxlength: [500, 'Media URL too long'] },
    type: { type: String, enum: ['image'] },
    width: { type: Number, min: 1, max: 20000 },
    height: { type: Number, min: 1, max: 20000 },
    name: { type: String, maxlength: [200, 'Filename too long'] }
  }
}, { timestamps: true });

// Fast history fetch: latest messages per room, newest first.
messageSchema.index({ roomId: 1, createdAt: -1 });

// TTL index is background storage cleanup ONLY (Mongo's TTL monitor is
// async, ~once a minute): reads exclude expired messages at query time
// via lib/fadingChat.notExpiredFilter, so expiry is visible immediately.
messageSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Message', messageSchema);
