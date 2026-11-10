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
//   3. Find user by googleId; else by email (link googleId to the existing
//      account); else create a new user with a random, unusable password
//      hash — never a known value — so the account can only be entered
//      via Google.
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
  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase().trim(),
    name: (payload.name || '').trim().slice(0, 60),
    picture: payload.picture || ''
  };
};

// Find the user for a verified Google identity, creating/linking as needed.
const findOrCreateGoogleUser = async ({ googleId, email, name }) => {
  const normalizedEmail = email.toLowerCase().trim();
  let user = await User.findOne({ googleId });
  if (user) return user;
  user = await User.findOne({ email: normalizedEmail });
  if (user) {
    user.googleId = googleId;
    if (!user.name && name) user.name = name;
    await user.save();
    return user;
  }
  // Random unusable password: the account is Google-only by construction.
  const salt = newSalt();
  user = new User({
    email: normalizedEmail,
    name: name || normalizedEmail.split('@')[0],
    googleId,
    passwordSalt: salt,
    passwordHash: hashPassword(generateToken(), salt)
  });
  await user.save();
  return user;
};

module.exports = { getGoogleClientId, verifyGoogleCredential, findOrCreateGoogleUser };
