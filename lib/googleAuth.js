// Google one-tap sign-in: verify the ID-token JWT that Google Identity
// Services hands the browser, then find or create the matching Orbit user.
//
// Privacy: Google only ever sees the login event. No chat, room, or voice
// data goes to Google — voice stays peer-to-peer, chat stays on this server.
//
// Flow (no client secret needed — this is the ID-token flow):
//   1. Frontend loads https://accounts.google.com/gsi/client, renders the
//      Google button, gets a `credential` (a signed JWT) on click.
//   2. POST /api/auth/google { credential } -> verifyIdToken with audience
//      = GOOGLE_CLIENT_ID -> payload gives sub (Google user id), email,
//      name, picture.
//   3. Find user by googleId; else by email — but an email match
//      links ONLY when the caller is already signed in as that
//      account (proof of ownership, audit M1); an unauthenticated
//      sign-in onto a password account's email is refused, never
//      linked and never duplicated. Else create a new Google-only
//      user with a random, unusable password hash — never a known
//      value — so the account can only be entered via Google.
//      The token's email_verified claim must be true (refused
//      otherwise); a Google-created account therefore starts
//      email-verified.
//   4. Issue the normal session cookie, exactly like password login.
//
// The verifier is injectable so the handler logic is testable without
// network: pass { verify } in tests; production uses the real OAuth2Client.
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { hashPassword, newSalt, generateToken } = require('./passwords');

let client = null;

const getGoogleClientId = () => process.env.GOOGLE_CLIENT_ID || null;

const getClient = () => {
  if (!client) client = new OAuth2Client(getGoogleClientId());
  return client;
};

// Verify the Google ID token and return the normalized identity.
// `verify` is ({ idToken, audience }) => Promise<ticket>; defaults to the
// real OAuth2Client. Throws on any invalid/expired/wrong-audience token.
const verifyGoogleCredential = async (credential, verify) => {
  if (typeof credential !== 'string' || !credential) {
    throw new Error('Missing Google credential');
  }
  const verifyFn = verify || ((idToken) =>
    getClient().verifyIdToken({ idToken, audience: getGoogleClientId() }));
  const ticket = await verifyFn(credential);
  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw new Error('Invalid Google token payload');
  }
  // Audit M1/I7: Google's `email_verified` claim is the only proof
  // this Google account owns the email. Refuse unless it is
  // explicitly true — an unverified (or absent) claim must never
  // mint or link an account.
  if (payload.email_verified !== true) {
    throw new Error('Google email is not verified');
  }
  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase().trim(),
    name: (payload.name || '').trim().slice(0, 60),
    picture: payload.picture || ''
  };
};

// Find the user for a verified Google identity, creating/linking as needed.
//
// Linking rule (audit M1): a Google identity is NEVER linked into an
// existing password-registered account on the strength of the email
// alone — the attacker who registered the victim's email first would
// keep password access to the merged account. Linking is allowed only
// when the caller is already signed in AS that account
// (opts.currentUserId): the valid session is the proof of ownership.
// An unauthenticated sign-in whose email already belongs to a
// password account throws with code GOOGLE_LINK_REQUIRES_SIGNIN —
// the route answers 409 telling the user to sign in with their
// password first and link from Settings. No second account is ever
// silently created for the same email (the email unique index would
// reject it anyway).
const findOrCreateGoogleUser = async ({ googleId, email, name }, { currentUserId } = {}) => {
  const normalizedEmail = email.toLowerCase().trim();
  let user = await User.findOne({ googleId });
  if (user) return user;
  user = await User.findOne({ email: normalizedEmail });
  if (user) {
    if (!currentUserId || String(user._id) !== String(currentUserId)) {
      const err = new Error(
        'An account with this email already exists. Sign in with your password first, then link Google from Settings.'
      );
      err.code = 'GOOGLE_LINK_REQUIRES_SIGNIN';
      throw err;
    }
    user.googleId = googleId;
    if (!user.name && name) user.name = name;
    // Google attests this email (see verifyGoogleCredential), so
    // linking verifies it too.
    user.emailVerified = true;
    await user.save();
    return user;
  }
  // Random unusable password: the account is Google-only by construction.
  const salt = newSalt();
  user = new User({
    email: normalizedEmail,
    name: name || normalizedEmail.split('@')[0],
    googleId,
    // Google verified this email — a Google-created account starts verified.
    emailVerified: true,
    passwordSalt: salt,
    passwordHash: hashPassword(generateToken(), salt)
  });
  await user.save();
  return user;
};

// Link a verified Google identity to an ALREADY SIGNED-IN account
// (v0.9.1, POST /api/auth/google/link). Stricter than
// findOrCreateGoogleUser on purpose: that helper's create-new branch
// is sign-in behaviour, and a link route must never mint an account.
//
// Rules:
//   - The Google identity's email must match the signed-in user's
//     email (the session is the proof of ownership, audit M1 —
//     linking a Google account that uses a different email would
//     merge two people's identities). Mismatch throws
//     GOOGLE_LINK_EMAIL_MISMATCH.
//   - The Google account must not already be linked to a DIFFERENT
//     user (one Google account -> one Orbit account). Throws
//     GOOGLE_ALREADY_LINKED.
//   - Linking the same Google account again is a no-op success
//     ({ alreadyLinked: true }) — the Profile UI shows the linked
//     state instead of re-linking.
//   - A user who already linked a DIFFERENT Google account cannot
//     link a second one (one Google account per user). Throws
//     GOOGLE_ALREADY_LINKED.
// Linking verifies the email too (Google attests it — see
// verifyGoogleCredential, audit I7).
const linkGoogleAccount = async (user, { googleId, email }) => {
  const normalizedEmail = email.toLowerCase().trim();
  if (normalizedEmail !== user.email.toLowerCase().trim()) {
    const err = new Error(
      'That Google account uses a different email address — sign in with the Google account matching this Orbit account.'
    );
    err.code = 'GOOGLE_LINK_EMAIL_MISMATCH';
    throw err;
  }
  if (user.googleId) {
    if (user.googleId === googleId) {
      return { user, alreadyLinked: true };
    }
    const err = new Error('This account is already linked to a different Google account.');
    err.code = 'GOOGLE_ALREADY_LINKED';
    throw err;
  }
  const other = await User.findOne({ googleId });
  if (other) {
    const err = new Error('That Google account is already linked to another Orbit account.');
    err.code = 'GOOGLE_ALREADY_LINKED';
    throw err;
  }
  user.googleId = googleId;
  user.emailVerified = true;
  await user.save();
  return { user, alreadyLinked: false };
};

module.exports = { getGoogleClientId, verifyGoogleCredential, findOrCreateGoogleUser, linkGoogleAccount };
