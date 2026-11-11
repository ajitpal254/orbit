// Orbit API: auth (cookie sessions + double-submit CSRF), rooms, and
// per-room text chat. Live voice presence comes from lib/presence.js
// (populated by socket.io) and is attached to room listings.
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Session = require('../models/Session');
const Room = require('../models/Room');
const Message = require('../models/Message');
const Friendship = require('../models/Friendship');
const RoomInvite = require('../models/RoomInvite');
const { hashPassword, newSalt, generateToken, hashToken } = require('../lib/passwords');
const { encrypt, decrypt } = require('../lib/crypto');
const { getGoogleClientId, verifyGoogleCredential, findOrCreateGoogleUser } = require('../lib/googleAuth');
const logger = require('../lib/logger');
const { authMiddleware, parseCookies, rateLimitMiddleware, asyncHandler } = require('../middleware/auth');
const { validateRoomInput, validateMessageInput, accentById } = require('../lib/rooms');
const { areFriends, friendshipStatus, otherUserId, isRoomMember, canSeeRoom, findPendingInvite } = require('../lib/friends');
const { emitToUser } = require('../lib/socket');
const presence = require('../lib/presence');

const router = express.Router();

// Friend/invite/search traffic is low-frequency by nature; the same
// 15-minute window as the auth routes, with a slightly higher cap than
// login (search fires while typing, debounced on the client).
const friendLimit = rateLimitMiddleware(30, 15 * 60 * 1000);

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);
const userJson = (u) => ({ id: String(u._id), name: u.name, email: u.email });
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SESSION_DAYS = 30;
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// --- PUBLIC CONFIG ---

// GET /api/config — public: tells the frontend whether Google sign-in is
// configured, and which TURN relay to use for voice (if any). The client
// ID is a public identifier (it is embedded in the Google button anyway),
// so exposing it is safe. No secret is involved in the ID-token flow.
// TURN credentials are also client-visible by nature — any WebRTC client
// must hold them to allocate — they are quota-limited, not secret. They
// come from the server env (see README "Voice connectivity (TURN)").
router.get('/config', (req, res) => {
  const turn =
    process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL
      ? {
          urls: (process.env.TURN_URLS ||
            'turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:443,turn:standard.relay.metered.ca:443?transport=tcp')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          username: process.env.TURN_USERNAME,
          credential: process.env.TURN_CREDENTIAL
        }
      : null;
  res.json({ googleClientId: getGoogleClientId(), turn });
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

// --- USERS & FRIENDS ---

// GET /api/users/search?q= — find people to add, by name or email.
// Case-insensitive, excludes self, max 10 results. Each result carries
// the friendship status relative to me so the UI can show Add / Pending /
// Friends without a second round trip. Short queries return nothing
// rather than dumping the user list.
router.get('/users/search', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) return res.json([]);
  const pattern = new RegExp(escapeRegExp(q), 'i');
  const users = await User.find({
    _id: { $ne: req.user._id },
    $or: [{ name: pattern }, { email: pattern }]
  }).select('name email').limit(10).lean();
  const ids = users.map((u) => u._id);
  const rows = await Friendship.find({
    $or: [
      { requester: req.user._id, recipient: { $in: ids } },
      { requester: { $in: ids }, recipient: req.user._id }
    ]
  }).lean();
  res.json(users.map((u) => ({
    ...userJson(u),
    friendship: friendshipStatus(rows, req.user._id, u._id)
  })));
}));

// POST /api/friends/request { userId } — send a friend request. 400 on
// self, on an existing pending request in either direction (accept the
// incoming one instead), or on already-friends.
router.post('/friends/request', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { userId } = req.body || {};
  if (!isObjectId(userId)) return res.status(400).json({ error: 'Invalid user' });
  if (String(userId) === String(req.user._id)) {
    return res.status(400).json({ error: 'You cannot add yourself' });
  }
  const target = await User.findById(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const existing = await Friendship.findOne({
    $or: [
      { requester: req.user._id, recipient: target._id },
      { requester: target._id, recipient: req.user._id }
    ]
  });
  if (existing && existing.status === 'accepted') {
    return res.status(400).json({ error: 'Already friends' });
  }
  if (existing) {
    return res.status(400).json({ error: 'Friend request already pending' });
  }
  const friendship = await Friendship.create({
    requester: req.user._id, recipient: target._id, status: 'pending'
  });
  emitToUser(target._id, 'friend-request', {
    from: userJson(req.user), friendshipId: String(friendship._id)
  });
  req.log.info({ userId: String(req.user._id), targetId: String(target._id) }, 'Friend request sent');
  res.status(201).json({ id: String(friendship._id), user: userJson(target), status: 'pending' });
}));

// POST /api/friends/accept { userId } — accept a pending request I
// received from userId. 404 when no such pending request exists.
router.post('/friends/accept', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { userId } = req.body || {};
  if (!isObjectId(userId)) return res.status(400).json({ error: 'Invalid user' });
  const friendship = await Friendship.findOne({
    requester: userId, recipient: req.user._id, status: 'pending'
  });
  if (!friendship) return res.status(404).json({ error: 'No pending friend request from that user' });
  friendship.status = 'accepted';
  await friendship.save();
  const requester = await User.findById(userId);
  emitToUser(userId, 'friend-accepted', { by: userJson(req.user) });
  res.json({ id: String(friendship._id), user: requester ? userJson(requester) : null, status: 'accepted' });
}));

// POST /api/friends/decline { userId } — delete a pending request I
// received. 404 when no such pending request exists.
router.post('/friends/decline', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { userId } = req.body || {};
  if (!isObjectId(userId)) return res.status(400).json({ error: 'Invalid user' });
  const friendship = await Friendship.findOne({
    requester: userId, recipient: req.user._id, status: 'pending'
  });
  if (!friendship) return res.status(404).json({ error: 'No pending friend request from that user' });
  await Friendship.deleteOne({ _id: friendship._id });
  res.json({ message: 'Friend request declined' });
}));

// GET /api/friends — my friends plus pending requests in both directions.
router.get('/friends', authMiddleware, asyncHandler(async (req, res) => {
  const rows = await Friendship.find({
    $or: [{ requester: req.user._id }, { recipient: req.user._id }]
  }).lean();
  const otherIds = [...new Set(rows.map((r) => otherUserId(r, req.user._id)))];
  const users = await User.find({ _id: { $in: otherIds } }).select('name email').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const pick = (r) => {
    const u = byId.get(otherUserId(r, req.user._id));
    return u ? userJson(u) : null;
  };
  res.json({
    friends: rows.filter((r) => r.status === 'accepted').map(pick).filter(Boolean),
    pendingReceived: rows.filter((r) => r.status === 'pending' && String(r.recipient) === String(req.user._id)).map(pick).filter(Boolean),
    pendingSent: rows.filter((r) => r.status === 'pending' && String(r.requester) === String(req.user._id)).map(pick).filter(Boolean)
  });
}));

// DELETE /api/friends/:userId — remove an accepted friendship, either
// direction. 404 when no accepted friendship exists.
router.delete('/friends/:userId', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (!isObjectId(userId)) return res.status(400).json({ error: 'Invalid user' });
  const friendship = await Friendship.findOne({
    status: 'accepted',
    $or: [
      { requester: req.user._id, recipient: userId },
      { requester: userId, recipient: req.user._id }
    ]
  });
  if (!friendship) return res.status(404).json({ error: 'Not friends with that user' });
  await Friendship.deleteOne({ _id: friendship._id });
  res.json({ message: 'Friend removed' });
}));

// --- ROOMS ---

// Serialize a room with live presence attached.
// Room topics are stored AES-256-GCM encrypted; decrypt on read. If a
// stored topic cannot be decrypted (wrong/lost key, corrupt data), show
// nothing instead of failing the whole room list — and log it loudly.
// Private rooms also carry their members (populated with names when the
// query populated them) so the UI can show who belongs; public rooms
// omit the list. Rooms created before private rooms existed have no
// isPrivate/members and serialize as public.
const roomJson = (room, meId) => {
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
  const isPrivate = !!room.isPrivate;
  const members = (room.members || []).map((m) =>
    m && typeof m === 'object' && m._id
      ? { id: String(m._id), name: m.name || '' }
      : { id: String(m), name: '' }
  );
  return {
    id,
    name: room.name,
    topic,
    accent: accentById(room.accent),
    createdBy: String(room.createdBy),
    createdAt: room.createdAt,
    occupants: occ.map((o) => ({ userId: o.userId, name: o.name, speaking: o.speaking })),
    occupantCount: occ.length,
    isPrivate,
    memberCount: members.length,
    isMember: meId ? (isPrivate ? isRoomMember(room, meId) : true) : undefined,
    members: isPrivate ? members : undefined
  };
};

router.get('/rooms', authMiddleware, asyncHandler(async (req, res) => {
  // Public rooms for everyone, plus private rooms I belong to (member
  // or creator). Rooms without isPrivate (pre-private-rooms) match the
  // $ne: true branch and stay public.
  const rooms = await Room.find({
    $or: [
      { isPrivate: { $ne: true } },
      { members: req.user._id },
      { createdBy: req.user._id }
    ]
  }).sort({ updatedAt: -1 }).populate('members', 'name').lean();
  const json = rooms.map((r) => roomJson(r, req.user._id));
  // Live rooms first, then the rest by recency.
  json.sort((a, b) => b.occupantCount - a.occupantCount || new Date(b.createdAt) - new Date(a.createdAt));
  res.json(json);
}));

router.post('/rooms', authMiddleware, asyncHandler(async (req, res) => {
  const { ok, error, room } = validateRoomInput(req.body || {});
  if (!ok) return res.status(400).json({ error });
  // Topic is stored encrypted; validateRoomInput already checked the
  // plaintext length, so the ciphertext fits the raised model limit.
  const created = new Room({
    ...room,
    topic: encrypt(room.topic || ''),
    createdBy: req.user._id,
    // A private room starts with its creator as the only member.
    members: room.isPrivate ? [req.user._id] : []
  });
  await created.save();
  await created.populate('members', 'name');
  req.log.info({ userId: String(req.user._id), roomId: String(created._id) }, 'Room created');
  res.status(201).json(roomJson(created, req.user._id));
}));

router.get('/rooms/:id', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).populate('members', 'name');
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!canSeeRoom(room, req.user._id)) {
    return res.status(403).json({ error: 'This room is private' });
  }
  res.json(roomJson(room, req.user._id));
}));

router.delete('/rooms/:id', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (String(room.createdBy) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Only the room creator can delete it' });
  }
  await Room.deleteOne({ _id: room._id });
  await Message.deleteMany({ roomId: room._id });
  await RoomInvite.deleteMany({ room: room._id });
  res.json({ message: 'Room deleted' });
}));

// --- PRIVATE ROOM INVITES & LEAVE ---

// Serialize a room invite with the room + inviter names the UI needs.
const inviteJson = (invite, room, inviter) => ({
  id: String(invite._id),
  room: room ? { id: String(room._id), name: room.name, isPrivate: !!room.isPrivate } : null,
  inviter: inviter ? { id: String(inviter._id), name: inviter.name } : null,
  status: invite.status,
  createdAt: invite.createdAt
});

router.post('/rooms/:id/invite', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.isPrivate) return res.status(400).json({ error: 'Only private rooms use invites' });
  if (!isRoomMember(room, req.user._id)) {
    return res.status(403).json({ error: 'Only room members can invite' });
  }
  const { userId } = req.body || {};
  if (!isObjectId(userId)) return res.status(400).json({ error: 'Invalid user' });
  const invitee = await User.findById(userId);
  if (!invitee) return res.status(404).json({ error: 'User not found' });
  if (isRoomMember(room, invitee._id)) {
    return res.status(400).json({ error: 'That user is already a member' });
  }
  const friendRows = await Friendship.find({
    $or: [
      { requester: req.user._id, recipient: invitee._id },
      { requester: invitee._id, recipient: req.user._id }
    ]
  }).lean();
  if (!areFriends(friendRows, req.user._id, invitee._id)) {
    return res.status(400).json({ error: 'Only friends can be invited to a private room' });
  }
  // A pending invite is returned as-is (no duplicate rows); a previously
  // declined one is reopened instead of violating the unique index.
  const existing = await RoomInvite.findOne({ room: room._id, invitee: invitee._id });
  if (existing && existing.status === 'pending') {
    return res.json(inviteJson(existing, room, req.user));
  }
  if (existing) {
    existing.status = 'pending';
    existing.inviter = req.user._id;
    await existing.save();
    emitToUser(invitee._id, 'room-invite', { invite: inviteJson(existing, room, req.user) });
    return res.json(inviteJson(existing, room, req.user));
  }
  const invite = await RoomInvite.create({
    room: room._id, inviter: req.user._id, invitee: invitee._id, status: 'pending'
  });
  emitToUser(invitee._id, 'room-invite', { invite: inviteJson(invite, room, req.user) });
  req.log.info({ userId: String(req.user._id), roomId: String(room._id), inviteeId: String(invitee._id) }, 'Room invite sent');
  res.status(201).json(inviteJson(invite, room, req.user));
}));

router.post('/rooms/:id/leave', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.isPrivate) return res.status(400).json({ error: 'Public rooms have nothing to leave' });
  if (!isRoomMember(room, req.user._id)) {
    return res.status(403).json({ error: 'You are not a member of this room' });
  }
  await Room.updateOne({ _id: room._id }, { $pull: { members: req.user._id } });
  const remaining = await Room.findById(room._id);
  if (remaining && remaining.members.length === 0) {
    // Last member out — the private room (and its chat + invites) goes
    // with them instead of lingering as an empty locked room.
    await Room.deleteOne({ _id: room._id });
    await Message.deleteMany({ roomId: room._id });
    await RoomInvite.deleteMany({ room: room._id });
    return res.json({ message: 'Left the room — it was deleted as the last member left' });
  }
  res.json({ message: 'Left the room' });
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
  if (!canSeeRoom(room, req.user._id)) {
    return res.status(403).json({ error: 'This room is private' });
  }
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
  const messages = await Message.find({ roomId: room._id })
    .sort({ createdAt: -1 }).limit(limit).lean();
  res.json(messages.reverse().map(messageJson));
}));

router.post('/rooms/:id/messages', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!canSeeRoom(room, req.user._id)) {
    return res.status(403).json({ error: 'This room is private' });
  }
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

// --- ROOM INVITES (INBOX) ---

router.get('/invites', authMiddleware, asyncHandler(async (req, res) => {
  const invites = await RoomInvite.find({ invitee: req.user._id, status: 'pending' })
    .sort({ createdAt: -1 })
    .populate('room', 'name isPrivate')
    .populate('inviter', 'name')
    .lean();
  // Drop invites whose room was deleted — the accept path cleans them up,
  // but the list must never show a dead room.
  res.json(invites.filter((i) => i.room).map((i) => inviteJson(i, i.room, i.inviter)));
}));

router.post('/invites/:id/accept', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const invite = await RoomInvite.findById(req.params.id);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (String(invite.invitee) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Not your invite' });
  }
  if (invite.status !== 'pending') {
    return res.status(400).json({ error: 'Invite already answered' });
  }
  const room = await Room.findById(invite.room);
  if (!room) {
    // The room is gone — drop the stale invite and say so.
    await RoomInvite.deleteOne({ _id: invite._id });
    return res.status(403).json({ error: 'Room no longer exists' });
  }
  await Room.updateOne({ _id: room._id }, { $addToSet: { members: req.user._id } });
  invite.status = 'accepted';
  await invite.save();
  const inviter = await User.findById(invite.inviter);
  res.json(inviteJson(invite, room, inviter));
}));

router.post('/invites/:id/decline', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const invite = await RoomInvite.findById(req.params.id);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (String(invite.invitee) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Not your invite' });
  }
  if (invite.status !== 'pending') {
    return res.status(400).json({ error: 'Invite already answered' });
  }
  invite.status = 'declined';
  await invite.save();
  const room = await Room.findById(invite.room);
  const inviter = await User.findById(invite.inviter);
  res.json(inviteJson(invite, room, inviter));
}));

module.exports = router;
