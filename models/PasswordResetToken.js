const mongoose = require('mongoose');

// One row per outstanding password-reset email (v0.9.1). Same shape
// and guarantees as the email-verification tokens (see
// lib/emailVerification.js and models/EmailVerificationToken.js):
// only the SHA-256 hash of the token is stored — the raw token is
// emailed once and never persisted or logged. Single-use: resetting
// deletes the row. Expiry is 24h, enforced at read time
// (findOneAndDelete with expiresAt > now); the TTL index below is
// storage cleanup only, so a row that outlives its deadline still
// cannot reset a password.
const passwordResetTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema);
