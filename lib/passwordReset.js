// Forgot-password flow (v0.9.1): a single-use, 24h token emailed to
// the account holder, redeemed by POST /api/auth/reset-password.
//
// This deliberately reuses the verification-token pattern from
// lib/emailVerification.js: crypto-random token, SHA-256 hash stored,
// single-use (resetting deletes the row), 24h expiry enforced at read
// time. The reset link is `/#reset-password-<token>` — a hash, so the
// token never travels in an HTTP request line or a server log
// (middleware/requestLog.js logs full URLs); the frontend POSTs the
// token in the JSON body.
//
// Mail uses the Brevo HTTP API (lib/brevoApi.js) when BREVO_API_KEY
// is set, else the same nodemailer transport as verification email
// (lib/emailVerification.js getTransport — 10s connection/greeting/
// socket timeouts, so a dead SMTP fails fast instead of hanging the
// request the way signup used to, see PR #16). This mirrors PR #18:
// SMTP from Render to Brevo times out on both ports 587 and 465
// ("Connection timeout" after 10s, measured live 2026-11-14), while
// the Brevo API on port 443 delivers — verification mail proved it
// live (200 in 0.6s). Before this fix the reset path was SMTP-only,
// so forgot-password mail could never arrive live even after the
// verification path was fixed. sendPasswordResetEmail never throws:
// a failure returns { sent: false } and the route still answers
// 200 — the response must never reveal whether the email exists,
// and a mail outage must not leak account existence either.
const User = require('../models/User');
const Session = require('../models/Session');
const PasswordResetToken = require('../models/PasswordResetToken');
const { generateToken, hashToken, hashPassword, newSalt } = require('./passwords');
const { getTransport, appOrigin, isSmtpConfigured } = require('./emailVerification');
const { pickEmailChannel, sendViaBrevoApi } = require('./brevoApi');
const logger = require('./logger');

const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Issue a fresh single-use token for the user (any outstanding ones
// are revoked first) and return the RAW token — the caller emails
// it; only its hash is stored. Never log the returned value.
const createPasswordResetToken = async (userId) => {
  const token = generateToken();
  await PasswordResetToken.deleteMany({ user: userId });
  await PasswordResetToken.create({
    user: userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS)
  });
  return token;
};

// Send the reset email. Returns { sent: true } or
// { sent: false, reason } — a failure never throws, so the
// forgot-password route can always answer its generic 200.
const sendPasswordResetEmail = async (user, { createTransport, fetchImpl } = {}) => {
  const token = await createPasswordResetToken(user._id);
  const origin = appOrigin();
  const link = origin ? `${origin}/#reset-password-${token}` : null;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const subject = 'Reset your Orbit password';
  const text = link
    ? `Reset your Orbit password by opening this link (valid for 24 hours, single-use):\n\n${link}\n\nIf you did not request this, ignore this email — your password is unchanged.`
    : 'Password reset was requested for your Orbit account, but email is not fully configured on this server yet — please try again later.';
  const html = link
    ? `<p>Reset your Orbit password by opening this link (valid for 24 hours, single-use):</p><p><a href="${link}">Reset your password</a></p><p>If you did not request this, ignore this email — your password is unchanged.</p>`
    : undefined;

  // Brevo HTTP API first when its key is set — same pattern as
  // sendVerificationEmail (PR #18). SMTP from Render to Brevo times
  // out on both ports, so the API path on 443 is the one that
  // actually delivers in production.
  if (pickEmailChannel({ smtpConfigured: isSmtpConfigured() }) === 'brevo-api') {
    const result = await sendViaBrevoApi(
      { to: user.email, subject, text, html },
      { fetchImpl }
    );
    if (!result.sent) {
      logger.warn(
        { userId: String(user._id), reason: result.reason },
        'Password-reset email send failed'
      );
    }
    return result;
  }

  const transport = getTransport(createTransport);
  if (!transport) {
    logger.warn(
      { userId: String(user._id) },
      'Password-reset email not sent — SMTP is not configured; account cannot reset its password by email'
    );
    return { sent: false, reason: 'smtp-not-configured' };
  }
  try {
    await transport.sendMail({ from, to: user.email, subject, text, html });
  } catch (err) {
    logger.warn(
      { userId: String(user._id), err: err && err.message },
      'Password-reset email send failed'
    );
    return { sent: false, reason: 'send-failed' };
  }
  return { sent: true };
};

// Consume a token and reset the password: exactly one successful
// reset per token, and only while unexpired. Returns the user, or
// null when the token is unknown, expired, or already used.
//
// The new password is hashed with the existing PBKDF2 helpers, and
// every session the user holds is deleted — a reset is a "someone
// else may have had my account" event, so all other logins (this
// device included) must sign in again with the new password.
const resetPasswordWithToken = async (rawToken, newPassword) => {
  if (typeof rawToken !== 'string' || !rawToken) return null;
  if (typeof newPassword !== 'string' || newPassword.length < 12) return null;
  const row = await PasswordResetToken.findOneAndDelete({
    tokenHash: hashToken(rawToken),
    expiresAt: { $gt: new Date() }
  });
  if (!row) return null;
  const user = await User.findById(row.user);
  if (!user) return null;
  const salt = newSalt();
  user.passwordSalt = salt;
  user.passwordHash = hashPassword(newPassword, salt);
  await user.save();
  await PasswordResetToken.deleteMany({ user: user._id });
  await Session.deleteMany({ userId: user._id });
  return user;
};

module.exports = {
  PASSWORD_RESET_TTL_MS,
  createPasswordResetToken, sendPasswordResetEmail, resetPasswordWithToken
};
