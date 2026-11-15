const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  // TTL index (audit L5): MongoDB's TTL monitor deletes the row at
  // expiresAt (expireAfterSeconds: 0), so expired sessions do not
  // accumulate forever. Auth still rejects expired sessions at read
  // time — the TTL is storage hygiene only. The old plain index on
  // expiresAt is replaced by this TTL index; server.js syncIndexes()
  // rebuilds it on boot for databases created before this change.
  expiresAt: { type: Date, required: true, expires: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Session', sessionSchema);
