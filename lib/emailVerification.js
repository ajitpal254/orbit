// Email verification (audit M1): prove an account owns its email
// before it can be discovered, invite anyone, or create rooms.
//
// Flow:
//   1. Registration creates the account with emailVerified: false
//      and sends a verification email (best-effort — mail being down
//      never fails registration). Login stays allowed so the user can
//      reach the verify/resend flow.
//   2. The email links to `/#verify-email-<token>` — a hash, so the
//      token never travels in an HTTP request line or a server log
//      (middleware/requestLog.js logs full URLs). The frontend POSTs
//      the token in the JSON body to /api/auth/verify-email.
//   3. Tokens are crypto-random, stored only as SHA-256 hashes,
//      single-use (verify deletes the row), and expire after 24h.
//   4. Accounts created before verification existed have no
//      emailVerified field and count as verified (grandfathered) —
//      see isEmailVerified().
//   5. When SMTP is not configured, nothing is silently skipped:
//      sendVerificationEmail() returns { sent: false }, the account
//      stays unverified, and boot logs a clear warning (see
//      logSmtpStatus(), called from server.js). Nobody is
//      auto-verified.
//
// SMTP env vars (Render): SMTP_HOST, SMTP_PORT (default 587),
// SMTP_USER, SMTP_PASS, SMTP_FROM (defaults to SMTP_USER).
const nodemailer = require('nodemailer');
const User = require('../models/User');
const EmailVerificationToken = require('../models/EmailVerificationToken');
const { generateToken, hashToken } = require('./passwords');
const logger = require('./logger');

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Grandfathering: only an explicit `false` restricts. A missing field
// (pre-verification account) or `true` both count as verified.
const isEmailVerified = (user) => !user || user.emailVerified !== false;

const isSmtpConfigured = () => Boolean(
  process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
);

// Boot warning, same pattern as the crypto-key warning in server.js:
// an operator must see at a glance that verification mail cannot go
// out, instead of discovering it from users who can never verify.
const logSmtpStatus = () => {
  if (isSmtpConfigured()) {
    logger.info('SMTP configured — verification emails enabled');
  } else {
    logger.warn(
      'SMTP is not configured (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM) — ' +
      'new accounts stay unverified until verification email can be sent'
    );
  }
};

// Build a nodemailer transport from env, or null when SMTP is not
// configured. `createTransport` is injectable so tests can pass a
// fake without a real SMTP server. The SMTP password is read from
// env only — it is never logged or stored.
const getTransport = (createTransport) => {
  if (!isSmtpConfigured()) return null;
  const create = createTransport || nodemailer.createTransport;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return create({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
};

// The public origin the verification link points at. Render sets
// APP_URL; otherwise the first CORS origin is used. Empty when
// neither is set — the email then carries no link (see below).
const appOrigin = () =>
  (process.env.APP_URL || (process.env.CORS_ORIGIN || '').split(',')[0] || '')
    .replace(/\/+$/, '');

// Issue a fresh single-use token for the user (any outstanding ones
// are revoked first) and return the RAW token — the caller emails
// it; only its hash is stored. Never log the returned value.
const createVerificationToken = async (userId) => {
  const token = generateToken();
  await EmailVerificationToken.deleteMany({ user: userId });
  await EmailVerificationToken.create({
    user: userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS)
  });
  return token;
};

// Send the verification email. Returns { sent: true } or
// { sent: false, reason } — a failure never throws, so registration
// (and resend) never fail because mail is down or unconfigured; the
// account simply stays unverified.
const sendVerificationEmail = async (user, { createTransport } = {}) => {
  const token = await createVerificationToken(user._id);
  const transport = getTransport(createTransport);
  if (!transport) {
    logger.warn(
      { userId: String(user._id) },
      'Verification email not sent — SMTP is not configured; account stays unverified'
    );
    return { sent: false, reason: 'smtp-not-configured' };
  }
  const origin = appOrigin();
  const link = origin ? `${origin}/#verify-email-${token}` : null;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transport.sendMail({
      from,
      to: user.email,
      subject: 'Verify your Orbit email',
      text: link
        ? `Welcome to Orbit! Verify your email by opening this link (valid for 24 hours):\n\n${link}\n\nIf you did not create this account, ignore this email.`
        : 'Welcome to Orbit! Email verification is not fully configured on this server yet — please try resending the verification email later.',
      html: link
        ? `<p>Welcome to Orbit!</p><p><a href="${link}">Verify your email</a> (valid for 24 hours).</p><p>If you did not create this account, ignore this email.</p>`
        : undefined
    });
  } catch (err) {
    logger.warn(
      { userId: String(user._id), err: err && err.message },
      'Verification email send failed'
    );
    return { sent: false, reason: 'send-failed' };
  }
  return { sent: true };
};

// Consume a token: exactly one successful verify per token, and only
// while unexpired. Returns the verified user, or null when the token
// is unknown, expired, or already used.
const verifyEmailToken = async (rawToken) => {
  if (typeof rawToken !== 'string' || !rawToken) return null;
  const row = await EmailVerificationToken.findOneAndDelete({
    tokenHash: hashToken(rawToken),
    expiresAt: { $gt: new Date() }
  });
  if (!row) return null;
  const user = await User.findByIdAndUpdate(
    row.user,
    { $set: { emailVerified: true } },
    { returnDocument: 'after' }
  );
  if (!user) return null;
  await EmailVerificationToken.deleteMany({ user: user._id });
  return user;
};

module.exports = {
  EMAIL_VERIFICATION_TTL_MS, isEmailVerified, isSmtpConfigured,
  logSmtpStatus, getTransport, appOrigin,
  createVerificationToken, sendVerificationEmail, verifyEmailToken
};
