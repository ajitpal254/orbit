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
const DirectMessage = require('../models/DirectMessage');
const Notification = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');
const { validateProfileUpdate, profileJson } = require('../lib/profile');
const { notificationJson, recordNotification } = require('../lib/notifications');
const { getVapidPublicKey, isPushConfigured, sendPushToUser, pushPayloadFor } = require('../lib/push');
const { hashPassword, newSalt, generateToken, hashToken } = require('../lib/passwords');
const { encrypt, decrypt } = require('../lib/crypto');
const { getGoogleClientId, verifyGoogleCredential, findOrCreateGoogleUser } = require('../lib/googleAuth');
const logger = require('../lib/logger');
const { authMiddleware, parseCookies, rateLimitMiddleware, asyncHandler } = require('../middleware/auth');
const { validateRoomInput, validateMessageInput, accentById } = require('../lib/rooms');
const { areFriends, friendshipStatus, otherUserId, isRoomMember, canSeeRoom, findPendingInvite } = require('../lib/friends');
const { normalizeMembers, getRole, canPromote, canDemote, canKick, canMute, canTransfer, canLeave } = require('../lib/roles');
const { canDm, buildSummaries } = require('../lib/dms');
const { notExpiredFilter, withExpiry } = require('../lib/fadingChat');
const { aliveFilter, isVisible, keepRoom } = require('../lib/fadingRooms');
const { emitToUser, emitRoomsChanged, onlineUserIds, isMutedInRoom, setMutedInRoom, clearMutedForRoom, kickSocketsFromRoom } = require('../lib/socket');
const { buildFriendPresence } = require('../lib/friendPresence');
const presence = require('../lib/presence');

const router = express.Router();

// Friend/invite/search traffic is low-frequency by nature; the same
// 15-minute window as the auth routes, with a slightly higher cap than
// login (search fires while typing, debounced on the client).
const friendLimit = rateLimitMiddleware(30, 15 * 60 * 1000);

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);
// Public user shape for lists (friends, search, DMs, invites): name +
// avatar. The avatar image is a small client-downscaled data URL
// (≤200KB, usually ~10–30KB), so carrying it in list rows is fine.
const userJson = (u) => ({
  id: String(u._id), name: u.name, email: u.email,
  avatarPreset: u.avatarPreset || null, avatarImage: u.avatarImage || ''
});
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
  res.json({ googleClientId: getGoogleClientId(), turn, vapidPublicKey: getVapidPublicKey() });
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
    user: profileJson(user)
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
  res.json({ user: profileJson(req.user) });
}));

// --- PROFILE ---

// PATCH /api/users/me { name?, bio?, avatarPreset?, avatarImage? } —
// edit my public profile. Validation lives in lib/profile.js; only the
// sanitized fields are $set, so a stray field in the body is ignored.
router.patch('/users/me', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { ok, error, updates } = validateProfileUpdate(req.body || {});
  if (!ok) return res.status(400).json({ error });
  await User.updateOne({ _id: req.user._id }, { $set: updates });
  const fresh = await User.findById(req.user._id).lean();
  res.json({ user: profileJson(fresh) });
}));

// GET /api/users/avatars?ids=a,b,c — avatar data for a bounded set of
// users (room occupants, whose presence rows carry only id + name).
// Max 20 ids; each entry is { id, name, avatarPreset, avatarImage }.
router.get('/users/avatars', authMiddleware, asyncHandler(async (req, res) => {
  const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(isObjectId))].slice(0, 20);
  if (ids.length === 0) return res.json([]);
  const users = await User.find({ _id: { $in: ids } })
    .select('name avatarPreset avatarImage').lean();
  res.json(users.map((u) => ({
    id: String(u._id), name: u.name || '',
    avatarPreset: u.avatarPreset || null, avatarImage: u.avatarImage || ''
  })));
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
  }).select('name email avatarPreset avatarImage').limit(10).lean();
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
  // Persistent notification (deduped per actor) + best-effort web push.
  await recordNotification({
    userId: target._id, type: 'friend_request',
    actorId: req.user._id, actorName: req.user.name
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
  await recordNotification({
    userId, type: 'friend_accepted',
    actorId: req.user._id, actorName: req.user.name
  });
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
  const users = await User.find({ _id: { $in: otherIds } }).select('name email avatarPreset avatarImage').lean();
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

// GET /api/friends/presence — my accepted friends with a live status
// for the desktop right panel: in-room (with the room, when I can see
// it), online, or away. Derived from the socket registries that already
// track this — no new data source. A friend in a private room I cannot
// see shows as plain `online`, so the room is never leaked. Sorted
// in-room first, then online, then away (see lib/friendPresence.js).
router.get('/friends/presence', authMiddleware, asyncHandler(async (req, res) => {
  const rows = await Friendship.find({
    status: 'accepted',
    $or: [{ requester: req.user._id }, { recipient: req.user._id }]
  }).lean();
  const friendIds = [...new Set(rows.map((r) => otherUserId(r, req.user._id)))];
  const friends = await User.find({ _id: { $in: friendIds } })
    .select('name email avatarPreset avatarImage').lean();
  // Which visible room each occupant is in, from the live presence
  // snapshot (one Room lookup for the occupied rooms, not per friend).
  const snap = presence.snapshot();
  const roomIds = [...new Set(snap.map((s) => s.roomId))];
  const rooms = roomIds.length
    ? await Room.find({ _id: { $in: roomIds } }).lean()
    : [];
  const visibleById = new Map();
  for (const room of rooms) {
    if (canSeeRoom(room, req.user._id)) visibleById.set(String(room._id), room);
  }
  const roomByUser = new Map();
  for (const { roomId, occupants } of snap) {
    const room = visibleById.get(String(roomId));
    if (!room) continue;
    for (const o of occupants) {
      roomByUser.set(String(o.userId), { id: String(room._id), name: room.name });
    }
  }
  res.json(buildFriendPresence(friends.map(userJson), onlineUserIds(), roomByUser));
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
// Private rooms also carry their members (each { id, name, role }) so the
// UI can show who belongs and what they may do; public rooms omit the
// list. Rooms created before private rooms existed have no
// isPrivate/members and serialize as public.
//
// `profiles` is a Map(userId -> { name, avatarPreset, avatarImage })
// built by memberProfilesFor: member profiles are NOT resolved with
// populate, because legacy rooms store plain ObjectIds that
// populate('members.user') cannot resolve. Callers pass lean rooms
// (never hydrated docs — see lib/roles.js) plus the map.
const roomJson = (room, meId, profiles = new Map()) => {
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
  const members = normalizeMembers(room).map((m) => {
    const p = profiles.get(m.userId) || {};
    return {
      id: m.userId,
      name: p.name || '',
      role: m.role,
      avatarPreset: p.avatarPreset || null,
      avatarImage: p.avatarImage || ''
    };
  });
  return {
    id,
    name: room.name,
    topic,
    accent: accentById(room.accent),
    createdBy: String(room.createdBy),
    createdAt: room.createdAt,
    // Campfire state (fading rooms): ephemeral rooms carry their
    // server-set deadline; legacy/permanent rooms send null.
    ephemeral: !!room.ephemeral,
    expiresAt: room.expiresAt || null,
    occupants: occ.map((o) => ({ userId: o.userId, name: o.name, speaking: o.speaking })),
    occupantCount: occ.length,
    isPrivate,
    memberCount: members.length,
    isMember: meId ? (isPrivate ? isRoomMember(room, meId) : true) : undefined,
    members: isPrivate ? members : undefined
  };
};

// One User lookup for every member id across a set of lean rooms (new
// subdocuments AND legacy plain ObjectIds alike). Returns a Map of
// userId -> { name, avatarPreset, avatarImage } for the members panel.
const memberProfilesFor = async (rooms) => {
  const ids = new Set();
  for (const r of rooms || []) {
    for (const m of normalizeMembers(r)) ids.add(m.userId);
  }
  const profiles = new Map();
  if (ids.size === 0) return profiles;
  const users = await User.find({ _id: { $in: [...ids] } })
    .select('name avatarPreset avatarImage').lean();
  for (const u of users) {
    profiles.set(String(u._id), {
      name: u.name || '',
      avatarPreset: u.avatarPreset || null,
      avatarImage: u.avatarImage || ''
    });
  }
  return profiles;
};

// Re-read one room lean and serialize it with fresh member profiles —
// the standard response for role actions that changed the member list.
const freshRoomJson = async (roomId, meId) => {
  const room = await Room.findById(roomId).lean();
  if (!room) return null;
  const profiles = await memberProfilesFor([room]);
  return roomJson(room, meId, profiles);
};

// Rewrite a room's member list from a normalized [{ userId, role }]
// array. This also migrates legacy plain-ObjectId entries to subdocuments
// as a side effect. Never $pull/$addToSet raw ids — those operators cannot
// match both member shapes.
const writeMembers = (roomId, members) =>
  Room.updateOne({ _id: roomId }, {
    $set: { members: members.map((m) => ({ user: m.userId, role: m.role })) }
  });

// Load a private room for a role action. Returns { room } or
// { status, error } — 404 / 400 (not private) / 403 (not a member).
const loadPrivateRoomFor = async (roomId, userId) => {
  const room = await Room.findById(roomId).lean();
  if (!room) return { status: 404, error: 'Room not found' };
  if (!room.isPrivate) return { status: 400, error: 'Roles only apply to private rooms' };
  if (!isRoomMember(room, userId)) return { status: 403, error: 'You are not a member of this room' };
  return { room };
};

// Load the target user of a role action: 400 on a bad id, 404 when missing.
const loadTargetUser = async (userId) => {
  if (!isObjectId(userId)) return { status: 400, error: 'Invalid user' };
  const target = await User.findById(userId);
  if (!target) return { status: 404, error: 'User not found' };
  return { target };
};

router.get('/rooms', authMiddleware, asyncHandler(async (req, res) => {
  // Public rooms for everyone, plus private rooms I belong to (member
  // or creator). Rooms without isPrivate (pre-private-rooms) match the
  // $ne: true branch and stay public. Both member shapes are matched:
  // 'members.user' for subdocuments, 'members' for legacy plain ids.
  // Fading rooms: expired or cleanup-claimed rooms never reach the
  // list — expiry is enforced at read time, not when the worker runs.
  const rooms = await Room.find({
    $and: [
      {
        $or: [
          { isPrivate: { $ne: true } },
          { 'members.user': req.user._id },
          { members: req.user._id },
          { createdBy: req.user._id }
        ]
      },
      aliveFilter()
    ]
  }).sort({ updatedAt: -1 }).lean();
  const profiles = await memberProfilesFor(rooms);
  const json = rooms.map((r) => roomJson(r, req.user._id, profiles));
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
    // A private room starts with its creator as the only member, as owner.
    members: room.isPrivate ? [{ user: req.user._id, role: 'owner' }] : []
  });
  await created.save();
  req.log.info({ userId: String(req.user._id), roomId: String(created._id) }, 'Room created');
  emitRoomsChanged(created._id); // home screens pick the new room up live
  res.status(201).json(await freshRoomJson(created._id, req.user._id));
}));

router.get('/rooms/:id', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  // A faded campfire reads as gone, exactly like a deleted room — the
  // worker may not have swept it yet, but its deadline has passed.
  if (!room || !isVisible(room)) return res.status(404).json({ error: 'Room not found' });
  if (!canSeeRoom(room, req.user._id)) {
    return res.status(403).json({ error: 'This room is private' });
  }
  const profiles = await memberProfilesFor([room]);
  res.json(roomJson(room, req.user._id, profiles));
}));

// POST /api/rooms/:id/keep — the campfire owner's "Keep this room":
// make an ephemeral room permanent before it fades. Atomic: the
// conditional update wins only while the room is still an open
// campfire whose deadline has not passed; if cleanup already claimed
// it, the client gets the authoritative 410 instead of a silent
// success. Keeping an already-permanent room is a no-op success.
router.post('/rooms/:id/keep', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!isVisible(room)) return res.status(410).json({ error: 'This campfire has already faded' });
  if (!room.ephemeral) return res.json(await freshRoomJson(room._id, req.user._id));
  // Owner = the creator, or the role-owner after a transfer.
  const isOwner = String(room.createdBy) === String(req.user._id) ||
    getRole(room, req.user._id) === 'owner';
  if (!isOwner) return res.status(403).json({ error: 'Only the room owner can keep it' });
  const kept = await keepRoom(Room, room._id);
  if (!kept) return res.status(410).json({ error: 'This campfire has already faded' });
  req.log.info({ userId: String(req.user._id), roomId: String(room._id) }, 'Campfire kept — room is permanent now');
  emitRoomsChanged(room._id); // home screens pick the kept room up live
  res.json(await freshRoomJson(room._id, req.user._id));
}));

router.delete('/rooms/:id', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (String(room.createdBy) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Only the room creator can delete it' });
  }
  await Room.deleteOne({ _id: room._id });
  await Message.deleteMany({ roomId: room._id });
  await RoomInvite.deleteMany({ room: room._id });
  clearMutedForRoom(room._id);
  emitRoomsChanged(room._id); // home screens drop the deleted room live
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
  const room = await Room.findById(req.params.id).lean();
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
    await recordNotification({
      userId: invitee._id, type: 'room_invite',
      actorId: req.user._id, actorName: req.user.name,
      roomId: room._id, roomName: room.name
    });
    return res.json(inviteJson(existing, room, req.user));
  }
  const invite = await RoomInvite.create({
    room: room._id, inviter: req.user._id, invitee: invitee._id, status: 'pending'
  });
  emitToUser(invitee._id, 'room-invite', { invite: inviteJson(invite, room, req.user) });
  await recordNotification({
    userId: invitee._id, type: 'room_invite',
    actorId: req.user._id, actorName: req.user.name,
    roomId: room._id, roomName: room.name
  });
  req.log.info({ userId: String(req.user._id), roomId: String(room._id), inviteeId: String(invitee._id) }, 'Room invite sent');
  res.status(201).json(inviteJson(invite, room, req.user));
}));

router.post('/rooms/:id/leave', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.isPrivate) return res.status(400).json({ error: 'Public rooms have nothing to leave' });
  if (!isRoomMember(room, req.user._id)) {
    return res.status(403).json({ error: 'You are not a member of this room' });
  }
  const members = normalizeMembers(room);
  // The owner of a non-empty private room cannot leave until ownership
  // is transferred — otherwise the room would be left ownerless. The
  // owner alone in the room may leave; the room is deleted then.
  if (!canLeave(room, req.user._id)) {
    return res.status(400).json({ error: 'Transfer ownership first — the room owner cannot leave a non-empty private room' });
  }
  const remaining = members.filter((m) => m.userId !== String(req.user._id));
  setMutedInRoom(room._id, req.user._id, false);
  if (remaining.length === 0) {
    // Last member out — the private room (and its chat + invites) goes
    // with them instead of lingering as an empty locked room.
    await Room.deleteOne({ _id: room._id });
    await Message.deleteMany({ roomId: room._id });
    await RoomInvite.deleteMany({ room: room._id });
    clearMutedForRoom(room._id);
    return res.json({ message: 'Left the room — it was deleted as the last member left' });
  }
  await writeMembers(room._id, remaining);
  res.json({ message: 'Left the room' });
}));

// --- ROLES & MODERATION (private rooms only) ---
//
// Roles live on the member list (lib/roles.js): owner / moderator /
// member. The owner is Room.createdBy; every other check goes through
// the can* predicates so legacy plain-ObjectId members behave the same
// as subdocuments. Each route answers with the fresh room JSON so the
// client can update its member list directly.

// POST /api/rooms/:id/members/:userId/promote — owner only; a member
// becomes a moderator. 400 when the target is not a plain member.
router.post('/rooms/:id/members/:userId/promote', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { status, error, room } = await loadPrivateRoomFor(req.params.id, req.user._id);
  if (error) return res.status(status).json({ error });
  const { status: ts, error: terror, target } = await loadTargetUser(req.params.userId);
  if (terror) return res.status(ts).json({ error: terror });
  if (!canPromote(room, req.user._id, target._id)) {
    return res.status(403).json({ error: 'Only the room owner can promote members, and only members can be promoted' });
  }
  const members = normalizeMembers(room).map((m) =>
    m.userId === String(target._id) ? { ...m, role: 'moderator' } : m
  );
  await writeMembers(room._id, members);
  req.log.info({ userId: String(req.user._id), roomId: String(room._id), targetId: String(target._id) }, 'Member promoted to moderator');
  res.json(await freshRoomJson(room._id, req.user._id));
}));

// POST /api/rooms/:id/members/:userId/demote — owner only; a moderator
// goes back to member. 400 when the target is not a moderator.
router.post('/rooms/:id/members/:userId/demote', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { status, error, room } = await loadPrivateRoomFor(req.params.id, req.user._id);
  if (error) return res.status(status).json({ error });
  const { status: ts, error: terror, target } = await loadTargetUser(req.params.userId);
  if (terror) return res.status(ts).json({ error: terror });
  if (!canDemote(room, req.user._id, target._id)) {
    return res.status(403).json({ error: 'Only the room owner can demote moderators' });
  }
  const members = normalizeMembers(room).map((m) =>
    m.userId === String(target._id) ? { ...m, role: 'member' } : m
  );
  await writeMembers(room._id, members);
  req.log.info({ userId: String(req.user._id), roomId: String(room._id), targetId: String(target._id) }, 'Moderator demoted to member');
  res.json(await freshRoomJson(room._id, req.user._id));
}));

// POST /api/rooms/:id/members/:userId/kick — the owner can kick anyone
// except themself; a moderator can kick members only (not the owner, not
// other moderators). The kicked user is removed from members, loses any
// pending invites for the room, and their sockets are forced out of the
// room with a `room-kicked` event.
router.post('/rooms/:id/members/:userId/kick', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { status, error, room } = await loadPrivateRoomFor(req.params.id, req.user._id);
  if (error) return res.status(status).json({ error });
  const { status: ts, error: terror, target } = await loadTargetUser(req.params.userId);
  if (terror) return res.status(ts).json({ error: terror });
  if (!canKick(room, req.user._id, target._id)) {
    return res.status(403).json({ error: 'You cannot kick that member' });
  }
  const members = normalizeMembers(room).filter((m) => m.userId !== String(target._id));
  await writeMembers(room._id, members);
  await RoomInvite.deleteMany({ room: room._id, invitee: target._id });
  setMutedInRoom(room._id, target._id, false);
  kickSocketsFromRoom(target._id, room._id);
  req.log.info({ userId: String(req.user._id), roomId: String(room._id), targetId: String(target._id) }, 'Member kicked');
  res.json(await freshRoomJson(room._id, req.user._id));
}));

// POST /api/rooms/:id/transfer { userId } — owner only; ownership moves
// to another member (member or moderator). The old owner becomes a
// moderator and createdBy follows the new owner, so room deletion moves
// with ownership.
router.post('/rooms/:id/transfer', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { status, error, room } = await loadPrivateRoomFor(req.params.id, req.user._id);
  if (error) return res.status(status).json({ error });
  const { userId } = req.body || {};
  const { status: ts, error: terror, target } = await loadTargetUser(userId);
  if (terror) return res.status(ts).json({ error: terror });
  if (!canTransfer(room, req.user._id, target._id)) {
    return res.status(403).json({ error: 'Only the room owner can transfer ownership, and only to another member' });
  }
  const members = normalizeMembers(room).map((m) => {
    if (m.userId === String(target._id)) return { ...m, role: 'owner' };
    if (m.userId === String(req.user._id)) return { ...m, role: 'moderator' };
    return m;
  });
  await writeMembers(room._id, members);
  await Room.updateOne({ _id: room._id }, { $set: { createdBy: target._id } });
  req.log.info({ userId: String(req.user._id), roomId: String(room._id), targetId: String(target._id) }, 'Room ownership transferred');
  res.json(await freshRoomJson(room._id, req.user._id));
}));

// POST /api/rooms/:id/members/:userId/mute — owner or moderator; toggles
// a cooperative server-mute for a member (never the owner). Voice is
// P2P, so the server cannot force a client silent: it records the mute
// and tells the target's sockets via `moderator-muted` /
// `moderator-unmuted`, and the client honors it (see RoomView). The
// muted state survives rejoin — join-room re-applies it. Response:
// { muted, userId, roomId }.
router.post('/rooms/:id/members/:userId/mute', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { status, error, room } = await loadPrivateRoomFor(req.params.id, req.user._id);
  if (error) return res.status(status).json({ error });
  const { status: ts, error: terror, target } = await loadTargetUser(req.params.userId);
  if (terror) return res.status(ts).json({ error: terror });
  if (!canMute(room, req.user._id, target._id)) {
    return res.status(403).json({ error: 'Only the owner or a moderator can mute members, and never the owner' });
  }
  const muted = !isMutedInRoom(room._id, target._id);
  setMutedInRoom(room._id, target._id, muted);
  const by = req.user.name || 'A moderator';
  emitToUser(target._id, muted ? 'moderator-muted' : 'moderator-unmuted', {
    roomId: String(room._id), by
  });
  req.log.info({ userId: String(req.user._id), roomId: String(room._id), targetId: String(target._id), muted }, 'Moderator mute toggled');
  res.json({ muted, userId: String(target._id), roomId: String(room._id) });
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
  const room = await Room.findById(req.params.id).lean();
  if (!room || !isVisible(room)) return res.status(404).json({ error: 'Room not found' });
  if (!canSeeRoom(room, req.user._id)) {
    return res.status(403).json({ error: 'This room is private' });
  }
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
  // Fading chat: expired messages (expireAt at or before now) never
  // reach the client — the TTL index only cleans up storage later.
  const messages = await Message.find({ roomId: room._id, ...notExpiredFilter() })
    .sort({ createdAt: -1 }).limit(limit).lean();
  res.json(messages.reverse().map(messageJson));
}));

router.post('/rooms/:id/messages', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room || !isVisible(room)) return res.status(404).json({ error: 'Room not found' });
  if (!canSeeRoom(room, req.user._id)) {
    return res.status(403).json({ error: 'This room is private' });
  }
  const { ok, error, text } = validateMessageInput(req.body || {});
  if (!ok) return res.status(400).json({ error });
  const msg = await Message.create(withExpiry({
    roomId: room._id,
    userId: req.user._id,
    name: req.user.name,
    // Stored encrypted; the broadcast below sends the plaintext to room
    // members over their own TLS/WSS connection — that is correct.
    text: encrypt(text)
  }));
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
  const room = await Room.findById(invite.room).lean();
  if (!room) {
    // The room is gone — drop the stale invite and say so.
    await RoomInvite.deleteOne({ _id: invite._id });
    return res.status(403).json({ error: 'Room no longer exists' });
  }
  // New members join as plain members (subdocument shape); the write
  // also migrates any legacy plain-ObjectId entries.
  const members = normalizeMembers(room);
  if (!members.some((m) => m.userId === String(req.user._id))) {
    members.push({ userId: String(req.user._id), role: 'member' });
  }
  await writeMembers(room._id, members);
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
  const room = await Room.findById(invite.room).lean();
  const inviter = await User.findById(invite.inviter);
  res.json(inviteJson(invite, room, inviter));
}));

// --- DIRECT MESSAGES (FRIENDS ONLY) ---

// DM text is stored AES-256-GCM encrypted, exactly like room messages.
// Decrypt on read; a message that cannot be decrypted shows a
// placeholder instead of breaking the thread — and logs loudly.
const decryptDmText = (m) => {
  try {
    return decrypt(m.text);
  } catch (err) {
    logger.warn({ messageId: String(m._id) }, 'Stored DM could not be decrypted — check DATA_ENCRYPTION_KEY');
    return '[This message could not be decrypted]';
  }
};

const dmJson = (m, senderName) => ({
  id: String(m._id),
  senderId: String(m.sender),
  recipientId: String(m.recipient),
  senderName: senderName || '',
  text: decryptDmText(m),
  read: !!m.read,
  createdAt: m.createdAt
});

// The other side of an accepted friendship, from my point of view.
const acceptedFriendRows = (meId, otherId) => Friendship.find({
  $or: [
    { requester: meId, recipient: otherId },
    { requester: otherId, recipient: meId }
  ]
}).lean();

// GET /api/dms — one entry per accepted friend: last message (decrypted)
// + unread count. Sorted by last-message recency; friends with no
// messages go last, by name.
router.get('/dms', authMiddleware, asyncHandler(async (req, res) => {
  const rows = await Friendship.find({
    status: 'accepted',
    $or: [{ requester: req.user._id }, { recipient: req.user._id }]
  }).lean();
  const friendIds = [...new Set(rows.map((r) => otherUserId(r, req.user._id)))];
  const friends = await User.find({ _id: { $in: friendIds } }).select('name email avatarPreset avatarImage').lean();
  // All DMs involving me, newest first (capped — the summary only needs
  // the latest per friend; threads fetch the rest). Fading chat:
  // expired DMs never surface as a last message or an unread count.
  const dms = await DirectMessage.find({
    $and: [
      { $or: [{ sender: req.user._id }, { recipient: req.user._id }] },
      notExpiredFilter()
    ]
  }).sort({ createdAt: -1 }).limit(1000).lean();
  const plain = dms.map((m) => ({ ...m, text: decryptDmText(m) }));
  res.json(buildSummaries(friends.map(userJson), plain, req.user._id));
}));

// GET /api/dms/:userId — the thread with that friend, latest 50,
// oldest first. 403 unless an accepted friend. Opening the thread marks
// their messages to me as read.
router.get('/dms/:userId', authMiddleware, asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (!isObjectId(userId)) return res.status(400).json({ error: 'Invalid user' });
  const other = await User.findById(userId);
  if (!other) return res.status(404).json({ error: 'User not found' });
  const friendRows = await acceptedFriendRows(req.user._id, other._id);
  if (!canDm(friendRows, req.user._id, other._id)) {
    return res.status(403).json({ error: 'Direct messages are for friends only' });
  }
  await DirectMessage.updateMany(
    { sender: other._id, recipient: req.user._id, read: false, ...notExpiredFilter() },
    { read: true }
  );
  // Fading chat: expired messages never reach the thread view.
  const messages = await DirectMessage.find({
    $and: [
      {
        $or: [
          { sender: req.user._id, recipient: other._id },
          { sender: other._id, recipient: req.user._id }
        ]
      },
      notExpiredFilter()
    ]
  }).sort({ createdAt: -1 }).limit(50).lean();
  const names = new Map([
    [String(req.user._id), req.user.name],
    [String(other._id), other.name]
  ]);
  res.json(messages.reverse().map((m) => dmJson(m, names.get(String(m.sender)))));
}));

// POST /api/dms/:userId { text } — send a DM. 403 unless an accepted
// friend; text validated like room messages; stored encrypted; the
// recipient gets a live `dm-message` push with the plaintext payload.
router.post('/dms/:userId', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (!isObjectId(userId)) return res.status(400).json({ error: 'Invalid user' });
  const other = await User.findById(userId);
  if (!other) return res.status(404).json({ error: 'User not found' });
  const friendRows = await acceptedFriendRows(req.user._id, other._id);
  if (!canDm(friendRows, req.user._id, other._id)) {
    return res.status(403).json({ error: 'Direct messages are for friends only' });
  }
  const { ok, error, text } = validateMessageInput(req.body || {});
  if (!ok) return res.status(400).json({ error });
  const msg = await DirectMessage.create(withExpiry({
    sender: req.user._id,
    recipient: other._id,
    // Stored encrypted; the push below sends the plaintext to the
    // recipient over their own TLS/WSS connection — that is correct.
    text: encrypt(text)
  }));
  const payload = dmJson(msg, req.user.name);
  emitToUser(other._id, 'dm-message', payload);
  // One unread DM notification per sender (deduped) + best-effort push.
  await recordNotification({
    userId: other._id, type: 'dm',
    actorId: req.user._id, actorName: req.user.name
  });
  req.log.info({ userId: String(req.user._id), recipientId: String(other._id) }, 'DM sent');
  res.status(201).json(payload);
}));

// --- NOTIFICATIONS (IN-APP CENTER) ---

// Batch-resolve the actors + rooms for a page of notifications so the
// serializer can show names without N+1 queries.
const notificationRefsFor = async (list) => {
  const actorIds = [...new Set(list.map((n) => String(n.actor)))];
  const roomIds = [...new Set(list.map((n) => n.room).filter(Boolean).map(String))];
  const actors = await User.find({ _id: { $in: actorIds } })
    .select('name avatarPreset avatarImage').lean();
  const rooms = roomIds.length
    ? await Room.find({ _id: { $in: roomIds } }).select('name').lean()
    : [];
  return {
    actors: new Map(actors.map((u) => [String(u._id), u])),
    rooms: new Map(rooms.map((r) => [String(r._id), r]))
  };
};

// GET /api/notifications?limit=&offset= — my notifications, newest
// first (updatedAt: a bumped unread row sorts as new). Always includes
// unreadCount so the bell badge can refresh from the same call.
router.get('/notifications', authMiddleware, asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 30));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const [list, unreadCount] = await Promise.all([
    Notification.find({ user: req.user._id })
      .sort({ updatedAt: -1, createdAt: -1 }).skip(offset).limit(limit).lean(),
    Notification.countDocuments({ user: req.user._id, read: false })
  ]);
  const { actors, rooms } = await notificationRefsFor(list);
  res.json({
    notifications: list.map((n) =>
      notificationJson(n, actors.get(String(n.actor)), n.room ? rooms.get(String(n.room)) : null)),
    unreadCount
  });
}));

// POST /api/notifications/:id/read — mark one of MY notifications read.
// 404 when it is not mine (or does not exist) — no cross-user reads.
router.post('/notifications/:id/read', authMiddleware, asyncHandler(async (req, res) => {
  const n = await Notification.findOne({ _id: req.params.id, user: req.user._id });
  if (!n) return res.status(404).json({ error: 'Notification not found' });
  if (!n.read) {
    n.read = true;
    await n.save();
  }
  res.json({ id: String(n._id), read: true });
}));

// POST /api/notifications/read-all — mark all of mine read.
router.post('/notifications/read-all', authMiddleware, asyncHandler(async (req, res) => {
  await Notification.updateMany(
    { user: req.user._id, read: false },
    { read: true }
  );
  res.json({ message: 'All notifications marked as read' });
}));

// --- WEB PUSH SUBSCRIPTIONS ---

// A push subscription is { endpoint, keys: { p256dh, auth } } from the
// browser's PushManager. The endpoint is globally unique — resubscribing
// from the same browser updates the row instead of duplicating it.
const isValidSubscription = (s) =>
  s && typeof s === 'object' &&
  typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') &&
  s.keys && typeof s.keys === 'object' &&
  typeof s.keys.p256dh === 'string' && s.keys.p256dh.length > 0 &&
  typeof s.keys.auth === 'string' && s.keys.auth.length > 0;

router.post('/push/subscribe', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { subscription } = req.body || {};
  if (!isValidSubscription(subscription)) {
    return res.status(400).json({ error: 'Invalid push subscription' });
  }
  await PushSubscription.findOneAndUpdate(
    { endpoint: subscription.endpoint },
    { user: req.user._id, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
    { upsert: true, returnDocument: 'after' }
  );
  res.json({ subscribed: true });
}));

router.post('/push/unsubscribe', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { endpoint } = req.body || {};
  if (typeof endpoint === 'string' && endpoint) {
    await PushSubscription.deleteOne({ endpoint, user: req.user._id });
  }
  res.json({ subscribed: false });
}));

// POST /api/push/test — send a test push to your own subscriptions so
// push can be verified in one tap (Profile has a button for it), and
// leave an in-app test notification behind so the bell shows it too.
// Self-targeted only: the only person it can ever notify is the
// caller. Returns how many subscriptions the push was sent to.
router.post('/push/test', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  if (!isPushConfigured()) {
    return res.status(400).json({ error: 'Push is not set up yet on the server' });
  }
  const payload = pushPayloadFor({ type: 'test', actorName: req.user.name });
  const sent = await sendPushToUser(req.user._id, payload);
  // In-app row, deduped like every other notification — created
  // directly, not via recordNotification, which would fire a second
  // push for the same event.
  await Notification.findOneAndUpdate(
    { user: req.user._id, type: 'test', actor: req.user._id, room: null, read: false },
    {
      $setOnInsert: { user: req.user._id, type: 'test', actor: req.user._id, room: null, read: false },
      $set: { updatedAt: new Date() }
    },
    { upsert: true, returnDocument: 'after' }
  );
  res.json({ sent });
}));

module.exports = router;
