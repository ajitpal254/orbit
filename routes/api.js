// Orbit API: auth (cookie sessions + double-submit CSRF), rooms, and
// per-room text chat. Live voice presence comes from lib/presence.js
// (populated by socket.io) and is attached to room listings.
const express = require('express');
const crypto = require('crypto');
const User = require('../models/User');
const Session = require('../models/Session');
const Room = require('../models/Room');
const Message = require('../models/Message');
const { hashPassword, newSalt, generateToken, hashToken } = require('../lib/passwords');
const { encrypt, decrypt } = require('../lib/crypto');
const { getGoogleClientId, verifyGoogleCredential, findOrCreateGoogleUser } = require('../lib/googleAuth');
const logger = require('../lib/logger');
const { authMiddleware, parseCookies, rateLimitMiddleware, asyncHandler } = require('../middleware/auth');
const { validateRoomInput, validateMessageInput, accentById } = require('../lib/rooms');
const presence = require('../lib/presence');

const router = express.Router();

const SESSION_DAYS = 30;
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// --- PUBLIC CONFIG ---

// GET /api/config — public: tells the frontend whether Google sign-in is
// configured. The client ID is a public identifier (it is embedded in the
// Google button anyway), so exposing it is safe. No secret is involved in
// the ID-token flow.
router.get('/config', (req, res) => {
  res.json({ googleClientId: getGoogleClientId() });
});

// --- AUTH ---

// GET /api/auth/csrf-token — public bootstrap: issues the csrfToken cookie
// so login/register POSTs can pass the double-submit CSRF check.
// (This is the lesson from Calorie-Tracker: without it, first signup 403s.)
router.get('/auth/csrf-token', (req, res) => {
  const csrfToken = generateToken();
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader(
    'Set-Cookie',
    `csrfToken=${csrfToken}; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`
  );
  res.json({ csrfToken });
});

router.post('/auth/register', rateLimitMiddleware(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: 'Valid email required' });
  if (typeof password !== 'string' || password.length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters' });
  }
  const exists = await User.findOne({ email: email.toLowerCase().trim() });
  if (exists) return res.status(409).json({ error: 'Email already registered' });
  const salt = newSalt();
  const user = new User({
    email: email.toLowerCase().trim(),
    name: (name || '').trim().slice(0, 60),
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt)
  });
  await user.save();
  req.log.info({ userId: String(user._id) }, 'User registered');
  await issueSession(req, res, user);
}));

router.post('/auth/login', rateLimitMiddleware(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await User.findOne({ email: (email || '').toLowerCase().trim() });
  // Dummy hash so timing doesn't reveal whether the email exists.
  const salt = user ? user.passwordSalt : newSalt();
  const computed = hashPassword(password || '', salt);
  const ok = user && crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(user.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  await issueSession(req, res, user);
}));

async function issueSession(req, res, user) {
  const sessionToken = generateToken();
  const csrfToken = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await Session.create({ userId: user._id, tokenHash: hashToken(sessionToken), expiresAt });
  const secure = process.env.NODE_ENV === 'production';
  const cookie = (name, value, maxAge) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [
    cookie('sessionToken', sessionToken, SESSION_DAYS * 86400),
    'csrfToken=' + csrfToken + '; Path=/; SameSite=Lax; Max-Age=' + SESSION_DAYS * 86400 + (secure ? '; Secure' : '')
  ]);
  res.json({
    user: { id: user._id, email: user.email, name: user.name }
  });
}

router.post('/auth/logout', asyncHandler(async (req, res) => {
  const token = parseCookies(req.headers.cookie).sessionToken;
  if (token) await Session.deleteOne({ tokenHash: hashToken(token) });
  res.setHeader('Set-Cookie', [
    'sessionToken=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'csrfToken=; Path=/; SameSite=Lax; Max-Age=0'
  ]);
  res.json({ message: 'Logged out' });
}));

// POST /api/auth/google — one-tap sign-in/sign-up with a Google ID token.
// Body: { credential } (the JWT from Google Identity Services). The global
// CSRF middleware applies: the frontend sends the x-csrf-token header,
// exactly like password login. Rate-limited like password login.
router.post('/auth/google', rateLimitMiddleware(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  if (!getGoogleClientId()) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server' });
  }
  const { credential } = req.body || {};
  let identity;
  try {
    identity = await verifyGoogleCredential(credential);
  } catch (err) {
    req.log.info({ err: err.message }, 'Google token verification failed');
    return res.status(401).json({ error: 'Google sign-in failed — please try again' });
  }
  const user = await findOrCreateGoogleUser(identity);
  req.log.info({ userId: String(user._id), google: true }, 'User signed in with Google');
  await issueSession(req, res, user);
}));

router.get('/auth/me', authMiddleware, asyncHandler(async (req, res) => {
  const u = req.user;
  res.json({ user: { id: u._id, email: u.email, name: u.name } });
}));

// --- ROOMS ---

// Serialize a room with live presence attached.
// Room topics are stored AES-256-GCM encrypted; decrypt on read. If a
// stored topic cannot be decrypted (wrong/lost key, corrupt data), show
// nothing instead of failing the whole room list — and log it loudly.
const roomJson = (room) => {
  const id = String(room._id);
  const occ = presence.occupants(id);
  let topic = '';
  if (room.topic) {
    try {
      topic = decrypt(room.topic);
    } catch (err) {
      logger.warn({ roomId: id }, 'Stored room topic could not be decrypted — check DATA_ENCRYPTION_KEY');
    }
  }
  return {
    id,
    name: room.name,
    topic,
    accent: accentById(room.accent),
    createdBy: String(room.createdBy),
    createdAt: room.createdAt,
    occupants: occ.map((o) => ({ userId: o.userId, name: o.name, speaking: o.speaking })),
    occupantCount: occ.length
  };
};

router.get('/rooms', authMiddleware, asyncHandler(async (req, res) => {
  const rooms = await Room.find().sort({ updatedAt: -1 }).lean();
  const json = rooms.map(roomJson);
  // Live rooms first, then the rest by recency.
  json.sort((a, b) => b.occupantCount - a.occupantCount || new Date(b.createdAt) - new Date(a.createdAt));
  res.json(json);
}));

router.post('/rooms', authMiddleware, asyncHandler(async (req, res) => {
  const { ok, error, room } = validateRoomInput(req.body || {});
  if (!ok) return res.status(400).json({ error });
  // Topic is stored encrypted; validateRoomInput already checked the
  // plaintext length, so the ciphertext fits the raised model limit.
  const created = new Room({ ...room, topic: encrypt(room.topic || ''), createdBy: req.user._id });
  await created.save();
  req.log.info({ userId: String(req.user._id), roomId: String(created._id) }, 'Room created');
  res.status(201).json(roomJson(created));
}));

router.get('/rooms/:id', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(roomJson(room));
}));

router.delete('/rooms/:id', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (String(room.createdBy) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Only the room creator can delete it' });
  }
  await Room.deleteOne({ _id: room._id });
  await Message.deleteMany({ roomId: room._id });
  res.json({ message: 'Room deleted' });
}));

// --- ROOM CHAT ---

// Message text is stored AES-256-GCM encrypted; decrypt on read. A message
// that cannot be decrypted (wrong/lost key, corrupt data) shows a
// placeholder instead of breaking the whole history — and logs loudly.
const messageJson = (m) => {
  let text;
  try {
    text = decrypt(m.text);
  } catch (err) {
    logger.warn({ messageId: String(m._id) }, 'Stored message could not be decrypted — check DATA_ENCRYPTION_KEY');
    text = '[This message could not be decrypted]';
  }
  return {
    id: String(m._id),
    roomId: String(m.roomId),
    userId: String(m.userId),
    name: m.name,
    text,
    createdAt: m.createdAt
  };
};

router.get('/rooms/:id/messages', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
  const messages = await Message.find({ roomId: room._id })
    .sort({ createdAt: -1 }).limit(limit).lean();
  res.json(messages.reverse().map(messageJson));
}));

router.post('/rooms/:id/messages', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { ok, error, text } = validateMessageInput(req.body || {});
  if (!ok) return res.status(400).json({ error });
  const msg = await Message.create({
    roomId: room._id,
    userId: req.user._id,
    name: req.user.name,
    // Stored encrypted; the broadcast below sends the plaintext to room
    // members over their own TLS/WSS connection — that is correct.
    text: encrypt(text)
  });
  // Broadcast live to everyone in the room (socket.io attached on the app).
  const io = req.app.get('io');
  if (io) io.to(String(room._id)).emit('chat-message', messageJson(msg));
  res.status(201).json(messageJson(msg));
}));

module.exports = router;
