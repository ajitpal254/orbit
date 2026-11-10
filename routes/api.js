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
const { authMiddleware, parseCookies, rateLimitMiddleware, asyncHandler } = require('../middleware/auth');
const { validateRoomInput, validateMessageInput, accentById } = require('../lib/rooms');
const presence = require('../lib/presence');

const router = express.Router();

const SESSION_DAYS = 30;
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

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

router.get('/auth/me', authMiddleware, asyncHandler(async (req, res) => {
  const u = req.user;
  res.json({ user: { id: u._id, email: u.email, name: u.name } });
}));

// --- ROOMS ---

// Serialize a room with live presence attached.
const roomJson = (room) => {
  const id = String(room._id);
  const occ = presence.occupants(id);
  return {
    id,
    name: room.name,
    topic: room.topic,
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
  const created = new Room({ ...room, createdBy: req.user._id });
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

const messageJson = (m) => ({
  id: String(m._id),
  roomId: String(m.roomId),
  userId: String(m.userId),
  name: m.name,
  text: m.text,
  createdAt: m.createdAt
});

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
    text
  });
  // Broadcast live to everyone in the room (socket.io attached on the app).
  const io = req.app.get('io');
  if (io) io.to(String(room._id)).emit('chat-message', messageJson(msg));
  res.status(201).json(messageJson(msg));
}));

module.exports = router;
