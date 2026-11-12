const mongoose = require('mongoose');

// One row per outstanding email-verification email (audit M1). Only
// the SHA-256 hash of the token is stored — the raw token is emailed
// once and never persisted or logged (same pattern as session tokens,
// see lib/passwords.js). Single-use: verifying deletes the row.
// Expiry is 24h, enforced at read time (findOneAndDelete with
// expiresAt > now); the TTL index below is storage cleanup only, so
// a row that outlives its deadline still cannot verify.
const emailVerificationTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

emailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('EmailVerificationToken', emailVerificationTokenSchema);
