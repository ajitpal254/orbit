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
const InviteLink = require('../models/InviteLink');
const { generateInviteToken, isValidInviteToken, expiryForRoom, isLinkExpired, canCreateInviteLink, canRevokeInviteLink, canJoinViaLink } = require('../lib/inviteLinks');
const Knock = require('../models/Knock');
const DirectMessage = require('../models/DirectMessage');
const Notification = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');
const { validateProfileUpdate, profileJson } = require('../lib/profile');
const { normalizeMood } = require('../lib/mood');
const { notificationJson, recordNotification } = require('../lib/notifications');
const { getVapidPublicKey, isPushConfigured, sendPushToUser, pushPayloadFor } = require('../lib/push');
const { turnUrls } = require('../lib/turnCredentials');
const { turnHandler } = require('../lib/meteredTurn');
const { hashPassword, newSalt, generateToken, hashToken } = require('../lib/passwords');
const { encrypt, decrypt } = require('../lib/crypto');
const { getGoogleClientId, verifyGoogleCredential, findOrCreateGoogleUser } = require('../lib/googleAuth');
const { isEmailVerified, sendVerificationEmail, verifyEmailToken } = require('../lib/emailVerification');
const logger = require('../lib/logger');
const { authMiddleware, parseCookies, rateLimitMiddleware, asyncHandler } = require('../middleware/auth');
const { validateRoomInput, validateMessageInput, accentById } = require('../lib/rooms');
const { areFriends, friendshipStatus, otherUserId, isRoomMember, canSeeRoom, findPendingInvite } = require('../lib/friends');
const { normalizeMembers, getRole, canPromote, canDemote, canKick, canMute, canTransfer, canLeave } = require('../lib/roles');
const { addMember, removeMember, setMemberRole, transferOwnership } = require('../lib/membership');
const { canDm, buildSummaries } = require('../lib/dms');
const { notExpiredFilter, withExpiry } = require('../lib/fadingChat');
const { aliveFilter, isVisible, keepRoom } = require('../lib/fadingRooms');
const {
  expiryForKnock, isKnockPending, isKnockRateLimited,
  canKnock, knockBlockReason, canAnswerKnock, knockJson, notExpiredKnockFilter
} = require('../lib/knock');
const { emitToUser, emitToRoom, emitRoomsChanged, onlineUserIds, isMutedInRoom, setMutedInRoom, clearMutedForRoom, clearFocusTimer, kickSocketsFromRoom } = require('../lib/socket');
const { focusSessions, stopSession, clearSession, canControlFocus } = require('../lib/focusSessions');
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
  avatarPreset: u.avatarPreset || null, avatarImage: u.avatarImage || '',
  mood: normalizeMood(u.mood)
});
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SESSION_DAYS = 30;
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// Email verification gate (audit M1): an unverified account cannot
// be discovered, invite anyone, or create rooms until it verifies.
// Login stays allowed so the user can reach the verify/resend flow,
// and responding to inbound contact (accepting a friend request, an
// invite, a knock) is not gated. Returns false after answering 403.
const requireVerifiedEmail = (req, res) => {
  if (isEmailVerified(req.user)) return true;
  res.status(403).json({ error: 'Verify your email first — check your inbox, or resend the verification email from your profile' });
  return false;
};

// --- PUBLIC CONFIG ---

// GET /api/config — public: tells the frontend whether Google sign-in is
// configured, and which TURN relay servers to use for voice (if any). The
// client ID is a public identifier (it is embedded in the Google button
// anyway), so exposing it is safe. No secret is involved in the ID-token
// flow.
//
// TURN relay URLs are public too (they name a host, nothing more), so
// they stay here. TURN *credentials* are NOT here: the old design served
// the account's static TURN username/credential to anyone who asked
// (audit H2 — quota exhaustion by anyone on the internet). Credentials
// are now minted from Metered's REST API and cached server-side, behind
// session auth at GET /api/turn (see lib/meteredTurn.js); the static
// credential is never sent to a client. Rotate it on the provider side
// — assume the old one is public.
router.get('/config', (req, res) => {
  res.json({ googleClientId: getGoogleClientId(), turn: { urls: turnUrls() }, vapidPublicKey: getVapidPublicKey() });
});

// GET /api/turn — session-authenticated: serve the cached Metered
// TURN credential (minted via Metered's REST API, 24h expiry, cached
// and refreshed ahead of expiry — see lib/meteredTurn.js). Answers
// { turn: null } when METERED_SECRET_KEY / METERED_APP_DOMAIN are
// unset, or no credential could be minted; the client then uses STUN
// + the built-in fallback relays and voice keeps working.
router.get('/turn', authMiddleware, asyncHandler(async (req, res) => turnHandler(req, res)));

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
    // New accounts start unverified until they prove the email
    // (audit M1). Login still works — verification gates discovery,
    // invites, and room creation, not sign-in.
    emailVerified: false,
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt)
  });
  await user.save();
  // Best-effort: mail being down or unconfigured never fails
  // registration — the account simply stays unverified (and the
  // resend endpoint lets the user retry). Never log the token.
  const verification = await sendVerificationEmail(user);
  req.log.info({ userId: String(user._id), verificationEmailSent: verification.sent }, 'User registered');
  await issueSession(req, res, user, { verificationEmailSent: verification.sent });
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

async function issueSession(req, res, user, extra = {}) {
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
    user: profileJson(user),
    ...extra
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
//
// Linking (audit M1): when the request already carries a valid session
// for the password account with this email, the Google identity is
// linked to that account (the session is the proof of ownership).
// An unauthenticated sign-in whose email already belongs to a password
// account is REFUSED (409) — it never links into the account and no
// second account is created for the same email.
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
  // Best-effort read of the session cookie: a valid session as the
  // account with this email authorizes linking. No session (or an
  // expired one) just means an unauthenticated sign-in — it may
  // still create a brand-new Google-only account, but may never
  // link into an existing password account.
  let currentUser = null;
  try {
    const token = parseCookies(req.headers.cookie).sessionToken;
    if (token) {
      const session = await Session.findOne({ tokenHash: hashToken(token) });
      if (session && session.expiresAt >= new Date()) {
        currentUser = await User.findById(session.userId);
      }
    }
  } catch {
    currentUser = null;
  }
  let user;
  try {
    user = await findOrCreateGoogleUser(identity, {
      currentUserId: currentUser ? currentUser._id : null
    });
  } catch (err) {
    if (err.code === 'GOOGLE_LINK_REQUIRES_SIGNIN') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }
  req.log.info({ userId: String(user._id), google: true }, 'User signed in with Google');
  await issueSession(req, res, user);
}));

// POST /api/auth/verify-email { token } — consume a verification
// token (24h, single-use; see lib/emailVerification.js). Public: the
// token itself is the credential, so no session is needed. The token
// travels in the JSON body, never in a URL — the request log records
// full URLs, so a GET ?token= link would write the token to the
// logs. The emailed link is a #verify-email- hash the frontend
// POSTs here. Rate-limited like login.
router.post('/auth/verify-email', rateLimitMiddleware(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  const user = await verifyEmailToken(token);
  if (!user) {
    return res.status(400).json({ error: 'That verification link is invalid or has expired — request a new one from your profile' });
  }
  req.log.info({ userId: String(user._id) }, 'Email verified');
  res.json({ verified: true, user: profileJson(user) });
}));

// POST /api/auth/resend-verification — send a fresh verification
// email to my own address. Authenticated (only I can ask for mail to
// my address); rate-limited so it cannot be used to spam an inbox.
// 503 when SMTP is not configured — the account stays unverified
// rather than being silently auto-verified.
router.post('/auth/resend-verification', authMiddleware, rateLimitMiddleware(5, 15 * 60 * 1000), asyncHandler(async (req, res) => {
  if (isEmailVerified(req.user)) {
    return res.json({ message: 'Your email is already verified', alreadyVerified: true });
  }
  const result = await sendVerificationEmail(req.user);
  if (!result.sent) {
    return res.status(503).json({ error: 'Email verification is not set up on this server yet — please try again later' });
  }
  res.json({ message: 'Verification email sent — check your inbox', sent: true });
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
  // Unverified accounts are invisible here (audit M1): the
  // emailVerified: { $ne: false } filter also matches accounts with
  // no field at all — the grandfathered pre-verification rows.
  const users = await User.find({
    _id: { $ne: req.user._id },
    emailVerified: { $ne: false },
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
  // Unverified accounts cannot send invites (audit M1).
  if (!requireVerifiedEmail(req, res)) return;
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
    // Together mode: 'focus' rooms run a shared timer (the session
    // itself lives in memory — see lib/focusSessions.js); legacy rooms
    // send 'talk'.
    mode: room.mode === 'focus' ? 'focus' : 'talk',
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
  // Unverified accounts cannot create rooms (audit M1).
  if (!requireVerifiedEmail(req, res)) return;
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
    // A locked stub — just enough for the locked-room screen (name +
    // id). The id is unguessable, and topic / members / occupants stay
    // hidden, so a private room still leaks nothing to a stranger who
    // stumbles on its id. The frontend reads it off the thrown error
    // (see apiJson: err.room).
    return res.status(403).json({ error: 'This room is private', room: { id: String(room._id), name: room.name, isPrivate: true } });
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

// POST /api/rooms/:id/mode — the room owner or a moderator switches
// a room between 'talk' and 'focus' (Together mode). Switching a focus
// room back to 'talk' ends any running focus session: the session is
// cleared and 'focus-stopped' (reason 'mode-changed') is broadcast, so
// every client clears its ring at once. The mode change itself is
// broadcast as 'room-mode-changed' to the room, and 'rooms-changed'
// refreshes home lists (room cards carry a Focus badge).
router.post('/rooms/:id/mode', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room || !isVisible(room)) return res.status(404).json({ error: 'Room not found' });
  if (!canSeeRoom(room, req.user._id)) return res.status(403).json({ error: 'This room is private' });
  if (!canControlFocus(room, req.user._id)) {
    return res.status(403).json({ error: 'Only the room owner or a moderator can change the room mode' });
  }
  const mode = req.body?.mode;
  if (mode !== 'talk' && mode !== 'focus') return res.status(400).json({ error: 'Mode must be talk or focus' });
  if ((room.mode || 'talk') !== mode) {
    await Room.updateOne({ _id: room._id }, { $set: { mode } });
    if (mode === 'talk') {
      const stopped = stopSession(focusSessions, room._id);
      if (stopped) {
        clearFocusTimer(room._id);
        emitToRoom(room._id, 'focus-stopped', {
          roomId: String(room._id),
          stoppedBy: String(req.user._id),
          reason: 'mode-changed'
        });
      }
    }
    emitToRoom(room._id, 'room-mode-changed', { roomId: String(room._id), mode });
    emitRoomsChanged(room._id);
  }
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
  await InviteLink.deleteMany({ room: room._id });
  await Knock.deleteMany({ room: room._id });
  clearMutedForRoom(room._id);
  // A deleted room takes its focus session (and expiry timer) with it.
  clearSession(focusSessions, room._id);
  clearFocusTimer(room._id);
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
  // Unverified accounts cannot send invites (audit M1).
  if (!requireVerifiedEmail(req, res)) return;
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
  // The owner of a non-empty private room cannot leave until ownership
  // is transferred — otherwise the room would be left ownerless. The
  // owner alone in the room may leave; the room is deleted then.
  if (!canLeave(room, req.user._id)) {
    return res.status(400).json({ error: 'Transfer ownership first — the room owner cannot leave a non-empty private room' });
  }
  setMutedInRoom(room._id, req.user._id, false);
  // Atomic removal (audit M4): no read-then-$set of the member list.
  // When the owner leaves, the removal is conditional on the room
  // still having exactly one member — a member who joins between the
  // canLeave check and this update cannot leave the room ownerless.
  const isOwner = getRole(room, req.user._id) === 'owner';
  const removed = await removeMember(Room, room._id, req.user._id, { soleMemberOnly: isOwner });
  if (!removed.matchedCount) {
    // Lost a race: re-read to tell "room gone" from "someone joined".
    const fresh = await Room.findById(room._id).lean();
    if (!fresh) return res.json({ message: 'Left the room — it was deleted as the last member left' });
    if (isRoomMember(fresh, req.user._id)) {
      return res.status(400).json({ error: 'Transfer ownership first — the room owner cannot leave a non-empty private room' });
    }
    return res.json({ message: 'Left the room' });
  }
  // Leaving takes my invite link with me: the link admits friends of
  // its creator, and I am no longer in the room to vouch for them.
  await InviteLink.deleteMany({ room: room._id, createdBy: req.user._id });
  // Last member out — the private room (and its chat + invites) goes
  // with them instead of lingering as an empty locked room. Re-read
  // after the atomic removal: two members leaving at once both land
  // here, and the delete is idempotent. NOTE: check the RAW members
  // array, not normalizeMembers() — that helper re-adds the creator
  // as owner by design, so it never reads empty after a sole-owner
  // leave.
  const fresh = await Room.findById(room._id).lean();
  if (fresh && fresh.members.length === 0) {
    await Room.deleteOne({ _id: room._id });
    await Message.deleteMany({ roomId: room._id });
    await RoomInvite.deleteMany({ room: room._id });
    await InviteLink.deleteMany({ room: room._id });
    await Knock.deleteMany({ room: room._id });
    clearMutedForRoom(room._id);
    return res.json({ message: 'Left the room — it was deleted as the last member left' });
  }
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
  // Atomic role change (audit M4): the update wins only while the
  // target is still a plain member — a concurrent demote/kick/transfer
  // makes it miss, and the caller retries instead of overwriting it.
  const updated = await setMemberRole(Room, room._id, target._id, 'member', 'moderator');
  if (!updated) {
    return res.status(409).json({ error: 'That member changed just now — please retry' });
  }
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
  // Atomic role change (audit M4) — see promote.
  const updated = await setMemberRole(Room, room._id, target._id, 'moderator', 'member');
  if (!updated) {
    return res.status(409).json({ error: 'That member changed just now — please retry' });
  }
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
  // Atomic removal (audit M4): a concurrent join can no longer be
  // lost, and the kick itself cannot be undone by a stale $set.
  await removeMember(Room, room._id, target._id);
  await RoomInvite.deleteMany({ room: room._id, invitee: target._id });
  // A kicked member's invite link goes too — it admits friends of its
  // creator, and they are no longer in the room.
  await InviteLink.deleteMany({ room: room._id, createdBy: target._id });
  await Knock.deleteMany({ room: room._id, user: target._id });
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
  // One atomic update (audit M4): createdBy moves and both roles flip
  // together, gated on the expected current state. A concurrent
  // transfer misses and the caller retries.
  const updated = await transferOwnership(Room, room._id, req.user._id, target._id);
  if (!updated) {
    return res.status(409).json({ error: 'Ownership changed just now — please retry' });
  }
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
  // Atomic add (audit M4): new members join as plain members. A
  // matchedCount of 0 just means "already a member" — the re-read
  // below confirms the room is still there before answering.
  await addMember(Room, room._id, req.user._id, 'member');
  if (!await Room.exists({ _id: room._id })) {
    await RoomInvite.deleteOne({ _id: invite._id });
    return res.status(403).json({ error: 'Room no longer exists' });
  }
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

// --- INVITE LINKS (SHAREABLE JOIN LINKS) ---
//
// Playbook: "Invite links — Join without searching. Expiring for
// private rooms." One active link per room; the raw token is returned
// to its authorized viewers (they need it to build the shareable URL)
// and is never logged. See lib/inviteLinks.js for the rules: private
// links expire after 7 days, public links never expire; a private-room
// link admits only accepted friends of the link creator (the same
// rule as room invites); revocation is the link creator or the room
// owner — moderators cannot revoke.
//
// The link itself is `/#invite-<token>` (a hash, so the token never
// travels in an HTTP request line or server log — the frontend reads
// the hash and POSTs the token in the body to /invite-links/join —
// never in the URL path, so the token cannot land in a request line
// or server log (audit M2).

// Serialize a link for an authorized viewer, with the raw token the
// client needs to build the shareable URL.
const inviteLinkJson = (link, token, creatorName) => ({
  roomId: String(link.room),
  token,
  expiresAt: link.expiresAt || null,
  createdBy: { id: String(link.createdBy), name: creatorName || '' },
  createdAt: link.createdAt
});

// The stored token ciphertext, decrypted for an authorized viewer.
// Null when it cannot be decrypted (lost/rotated key) — the caller
// treats that link as unusable and replaces it on next create.
const decryptLinkToken = (link) => {
  try {
    return decrypt(link.token);
  } catch {
    return null;
  }
};

// POST /api/rooms/:id/invite-link — create the room's link, or return
// the existing active one (idempotent, like the pending room-invite
// flow). Private rooms: members only. Public rooms: any signed-in user.
router.post('/rooms/:id/invite-link', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!canCreateInviteLink(room, req.user._id)) {
    return res.status(403).json({ error: 'Only room members can create an invite link' });
  }
  let existing = await InviteLink.findOne({ room: room._id });
  if (existing) {
    if (!isLinkExpired(existing)) {
      const token = decryptLinkToken(existing);
      if (token) {
        const creator = await User.findById(existing.createdBy).select('name').lean();
        return res.json(inviteLinkJson(existing, token, creator ? creator.name : ''));
      }
      // Unreadable stored token (lost key) — drop the dead link and
      // make a fresh one below.
    }
    await InviteLink.deleteOne({ _id: existing._id });
    existing = null;
  }
  const token = generateInviteToken();
  let link;
  try {
    link = await InviteLink.create({
      room: room._id,
      createdBy: req.user._id,
      tokenHash: hashToken(token),
      token: encrypt(token),
      expiresAt: expiryForRoom(room)
    });
  } catch (err) {
    // Lost a race with another create for the same room (unique index
    // on room) — return the winner's link instead of failing.
    if (err && err.code === 11000) {
      const winner = await InviteLink.findOne({ room: room._id });
      if (winner && !isLinkExpired(winner)) {
        const winnerToken = decryptLinkToken(winner);
        if (winnerToken) {
          const creator = await User.findById(winner.createdBy).select('name').lean();
          return res.json(inviteLinkJson(winner, winnerToken, creator ? creator.name : ''));
        }
      }
    }
    throw err;
  }
  req.log.info({ userId: String(req.user._id), roomId: String(room._id) }, 'Invite link created');
  res.status(201).json(inviteLinkJson(link, token, req.user.name));
}));

// GET /api/rooms/:id/invite-link — my room's active link, if any.
// { link: null } when there is none (or it expired / is unreadable) —
// 200, not 404, so the UI treats "no link yet" as a normal state.
router.get('/rooms/:id/invite-link', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!canCreateInviteLink(room, req.user._id)) {
    return res.status(403).json({ error: 'Only room members can see the invite link' });
  }
  const link = await InviteLink.findOne({ room: room._id });
  if (!link || isLinkExpired(link)) return res.json({ link: null });
  const token = decryptLinkToken(link);
  if (!token) return res.json({ link: null });
  const creator = await User.findById(link.createdBy).select('name').lean();
  res.json({ link: inviteLinkJson(link, token, creator ? creator.name : '') });
}));

// DELETE /api/rooms/:id/invite-link — revoke the room's link. The link
// creator or the room owner; moderators cannot revoke. A revoked link
// is deleted, so it can never be redeemed again.
router.delete('/rooms/:id/invite-link', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const link = await InviteLink.findOne({ room: room._id });
  if (!link) return res.status(404).json({ error: 'No invite link for this room' });
  if (!canRevokeInviteLink(room, link, req.user._id)) {
    return res.status(403).json({ error: 'Only the link creator or the room owner can revoke it' });
  }
  await InviteLink.deleteOne({ _id: link._id });
  req.log.info({ userId: String(req.user._id), roomId: String(room._id) }, 'Invite link revoked');
  res.json({ message: 'Invite link revoked' });
}));

// POST /api/invite-links/join { token } — redeem a link. The token
// travels in the JSON body, never in the URL path: the old
// /invite-links/:token/join route put every redeemed token in the
// request line and the server logs (audit M2), so it was removed.
// The token is validated by shape first (no DB lookup for garbage),
// then by hash. Invalid and revoked links share one 404 message so
// the endpoint cannot tell an attacker whether a token ever existed;
// expired links get a distinct 410. A private-room join adds the
// user as a member (plain member, like accepting a room invite); a
// public-room join adds nothing — the room is already open. Answers
// with the fresh room JSON so the client can open the room directly.
router.post('/invite-links/join', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!isValidInviteToken(token)) {
    return res.status(404).json({ error: 'This invite link is invalid or has been revoked' });
  }
  const link = await InviteLink.findOne({ tokenHash: hashToken(token) });
  if (!link) {
    return res.status(404).json({ error: 'This invite link is invalid or has been revoked' });
  }
  if (isLinkExpired(link)) {
    // Sweep the stale row now — the TTL index would get it later.
    await InviteLink.deleteOne({ _id: link._id });
    return res.status(410).json({ error: 'This invite link has expired — ask for a fresh one' });
  }
  const room = await Room.findById(link.room).lean();
  if (!room) {
    await InviteLink.deleteOne({ _id: link._id });
    return res.status(404).json({ error: 'This invite link is invalid or has been revoked' });
  }
  // Private rooms admit only accepted friends of the link creator —
  // the same rule as room invites. Members skip the check.
  const friendRows = room.isPrivate && !isRoomMember(room, req.user._id)
    ? await Friendship.find({
        $or: [
          { requester: link.createdBy, recipient: req.user._id },
          { requester: req.user._id, recipient: link.createdBy }
        ]
      }).lean()
    : [];
  if (!canJoinViaLink(room, link, req.user._id, friendRows)) {
    return res.status(403).json({ error: 'This invite link is for friends of the person who shared it — ask them to add you as a friend first' });
  }
  if (room.isPrivate) {
    // Atomic add (audit M4); already a member is a no-op success.
    await addMember(Room, room._id, req.user._id, 'member');
  }
  req.log.info({ userId: String(req.user._id), roomId: String(room._id) }, 'Joined room via invite link');
  res.json(await freshRoomJson(room._id, req.user._id));
}));

// --- KNOCKS ON PRIVATE ROOMS ---
//
// The reverse of an invite: instead of waiting to be invited, a
// non-member friend of the room owner knocks and asks to be let in.
// The owner and moderators get a persistent notification (+ push +
// live socket) and admit or decline from the room's members panel.
//
// Knock vs the playbook's person-knock (Prompt B item 2, socket event
// 'knock' {toUserId}): this is the same low-pressure ask, scoped to
// a room so it can be answered with membership. It is REST + server
// socket fan-out, like invites — a bare client socket event could not
// persist the request for an offline owner, nor carry the
// admit/decline lifecycle. No new client→server socket event.

// The user ids that decide on knocks for a room: owner + moderators.
const knockTargets = (room) =>
  normalizeMembers(room)
    .filter((m) => m.role === 'owner' || m.role === 'moderator')
    .map((m) => m.userId);

// Tell the owner/moderators about a (new or reopened) knock: one
// persistent notification (+ best-effort push) each, and a live
// `knock-received` socket push so an open members panel refreshes.
const notifyKnock = async (room, knock, knocker) => {
  for (const targetId of knockTargets(room)) {
    await recordNotification({
      userId: targetId, type: 'knock',
      actorId: knock.user, actorName: knocker.name,
      roomId: room._id, roomName: room.name
    });
    emitToUser(targetId, 'knock-received', {
      knock: knockJson(knock, room, knocker), roomId: String(room._id)
    });
  }
};

// Load a private room for a knock action. Returns { room } or
// { status, error } — 404 / 410 (a faded campfire reads as gone, so
// nobody is ever admitted into a deleted room) / 400 (not private).
const loadRoomForKnock = async (roomId) => {
  const room = await Room.findById(roomId).lean();
  if (!room) return { status: 404, error: 'Room not found' };
  if (!isVisible(room)) return { status: 410, error: 'This campfire has already faded' };
  if (!room.isPrivate) return { status: 400, error: 'Only private rooms take knocks' };
  return { room };
};

// The friendship rows that decide a knock: knocker ↔ room owner.
const knockFriendRows = (knockerId, ownerId) => Friendship.find({
  $or: [
    { requester: knockerId, recipient: ownerId },
    { requester: ownerId, recipient: knockerId }
  ]
}).lean();

// POST /api/rooms/:id/knock — knock on a private room. A pending knock
// is returned as-is (no duplicate row, no second notification); a
// repeat within 30s of the last knock is rate-limited (429). A
// previously declined knock is reopened instead of violating the
// unique index — same pattern as invites.
router.post('/rooms/:id/knock', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { status, error, room } = await loadRoomForKnock(req.params.id);
  if (error) return res.status(status).json({ error });
  if (isRoomMember(room, req.user._id)) {
    return res.status(400).json({ error: 'You are already a member of this room' });
  }
  const friendRows = await knockFriendRows(req.user._id, room.createdBy);
  if (!canKnock(room, req.user._id, friendRows)) {
    return res.status(403).json({ error: 'Only friends of the room owner can knock — ask them to invite you' });
  }
  const existing = await Knock.findOne({ room: room._id, user: req.user._id });
  if (existing && isKnockPending(existing)) {
    if (isKnockRateLimited(existing.createdAt)) {
      return res.status(429).json({
        error: 'You already knocked — give them a moment before knocking again',
        knock: knockJson(existing, room, req.user)
      });
    }
    return res.json(knockJson(existing, room, req.user));
  }
  let knock;
  const reopened = !!existing;
  if (existing) {
    existing.status = 'pending';
    existing.expiresAt = expiryForKnock();
    await existing.save();
    knock = existing;
  } else {
    knock = await Knock.create({
      room: room._id, user: req.user._id, status: 'pending',
      expiresAt: expiryForKnock()
    });
  }
  await notifyKnock(room, knock, req.user);
  req.log.info({ userId: String(req.user._id), roomId: String(room._id), reopened }, 'Knock on private room');
  res.status(reopened ? 200 : 201).json(knockJson(knock, room, req.user));
}));

// GET /api/rooms/:id/knock — my knock status for the locked-room
// screen: my pending knock (if any), whether I am a member, and
// whether I may knock (+ the friendly reason when I may not).
router.get('/rooms/:id/knock', authMiddleware, asyncHandler(async (req, res) => {
  const { status, error, room } = await loadRoomForKnock(req.params.id);
  if (error) return res.status(status).json({ error });
  if (isRoomMember(room, req.user._id)) {
    return res.json({ knock: null, isMember: true, canKnock: false, reason: 'You are already a member of this room' });
  }
  const friendRows = await knockFriendRows(req.user._id, room.createdBy);
  const mine = await Knock.findOne({ room: room._id, user: req.user._id });
  res.json({
    knock: mine && isKnockPending(mine) ? knockJson(mine, room, req.user) : null,
    isMember: false,
    canKnock: canKnock(room, req.user._id, friendRows),
    reason: knockBlockReason(room, req.user._id, friendRows)
  });
}));

// DELETE /api/rooms/:id/knock — withdraw my pending knock. Only the
// knocker can withdraw it; the owner/moderators' panels refresh live.
router.delete('/rooms/:id/knock', authMiddleware, asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const deleted = await Knock.deleteOne({ room: room._id, user: req.user._id, status: 'pending' });
  if (!deleted.deletedCount) return res.status(404).json({ error: 'No pending knock to withdraw' });
  for (const targetId of knockTargets(room)) {
    emitToUser(targetId, 'knock-withdrawn', { roomId: String(room._id), userId: String(req.user._id) });
  }
  res.json({ message: 'Knock withdrawn' });
}));

// GET /api/rooms/:id/knocks — pending knocks on the room, for the
// owner/moderators' members panel. Expired knocks are filtered at read
// time, and knocks from users who became members another way (an
// invite accepted after knocking) are dropped — there is nothing left
// to answer for them.
router.get('/rooms/:id/knocks', authMiddleware, asyncHandler(async (req, res) => {
  const { status, error, room } = await loadRoomForKnock(req.params.id);
  if (error) return res.status(status).json({ error });
  if (!canAnswerKnock(room, req.user._id)) {
    return res.status(403).json({ error: 'Only the room owner or a moderator can see knocks' });
  }
  const knocks = await Knock.find({
    room: room._id, status: 'pending', ...notExpiredKnockFilter()
  }).sort({ createdAt: 1 }).lean();
  const live = knocks.filter((k) => !isRoomMember(room, k.user));
  const users = await User.find({ _id: { $in: live.map((k) => k.user) } })
    .select('name avatarPreset avatarImage').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  res.json(live.map((k) => knockJson(k, room, byId.get(String(k.user)) || null)));
}));

// Load a pending knock + its room for an answer action. Returns
// { knock, room } or { status, error } — 400 (bad id) / 404 / 410
// (room gone or faded — the stale knock is dropped, never answered)
// / 403 (not owner/mod).
const loadKnockForAnswer = async (knockId, userId) => {
  if (!isObjectId(knockId)) return { status: 400, error: 'Invalid knock' };
  const knock = await Knock.findById(knockId);
  if (!knock) return { status: 404, error: 'Knock not found' };
  const room = await Room.findById(knock.room).lean();
  if (!room) {
    await Knock.deleteOne({ _id: knock._id });
    return { status: 410, error: 'This room no longer exists' };
  }
  if (!isVisible(room)) {
    await Knock.deleteOne({ _id: knock._id });
    return { status: 410, error: 'This campfire has already faded' };
  }
  if (!canAnswerKnock(room, userId)) {
    return { status: 403, error: 'Only the room owner or a moderator can answer knocks' };
  }
  return { knock, room };
};

// Resolving a knock clears its notification rows, so the bell does
// not keep pointing at an answered knock.
const clearKnockNotifications = (knock, room) =>
  Notification.updateMany(
    { type: 'knock', actor: knock.user, room: room._id, read: false },
    { read: true }
  );

// POST /api/knocks/:id/admit — owner/mod only; the knocker becomes a
// plain member. The claim is atomic (pending + unexpired), so two
// moderators answering at once — or an answer racing the 24h expiry
// — resolves to exactly one winner.
router.post('/knocks/:id/admit', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { status, error, knock, room } = await loadKnockForAnswer(req.params.id, req.user._id);
  if (error) return res.status(status).json({ error });
  const claimed = await Knock.findOneAndUpdate(
    { _id: knock._id, status: 'pending', expiresAt: { $gt: new Date() } },
    { $set: { status: 'admitted' } },
    { returnDocument: 'after' }
  );
  if (!claimed) return res.status(400).json({ error: 'This knock was already answered or has expired' });
  // The knocker may have joined another way since knocking — the
  // atomic add is a no-op when they are already a member (audit M4).
  await addMember(Room, room._id, knock.user, 'member');
  await clearKnockNotifications(knock, room);
  const knocker = await User.findById(knock.user);
  emitToUser(knock.user, 'knock-admitted', { roomId: String(room._id), roomName: room.name });
  emitRoomsChanged(room._id); // the knocker's home list picks the room up live
  req.log.info({ userId: String(req.user._id), roomId: String(room._id), knockerId: String(knock.user) }, 'Knock admitted');
  res.json({ knock: knockJson(claimed, room, knocker), room: await freshRoomJson(room._id, req.user._id) });
}));

// POST /api/knocks/:id/decline — owner/mod only; the knock is cleared
// and the knocker is NOT added. They may knock again later (a fresh
// knock, after the 30s window) — a decline is not a ban.
router.post('/knocks/:id/decline', authMiddleware, friendLimit, asyncHandler(async (req, res) => {
  const { status, error, knock, room } = await loadKnockForAnswer(req.params.id, req.user._id);
  if (error) return res.status(status).json({ error });
  const claimed = await Knock.findOneAndUpdate(
    { _id: knock._id, status: 'pending', expiresAt: { $gt: new Date() } },
    { $set: { status: 'declined' } },
    { returnDocument: 'after' }
  );
  if (!claimed) return res.status(400).json({ error: 'This knock was already answered or has expired' });
  await clearKnockNotifications(knock, room);
  const knocker = await User.findById(knock.user);
  emitToUser(knock.user, 'knock-declined', { roomId: String(room._id), roomName: room.name });
  req.log.info({ userId: String(req.user._id), roomId: String(room._id), knockerId: String(knock.user) }, 'Knock declined');
  res.json({ knock: knockJson(claimed, room, knocker) });
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
// browser's PushManager. Subscriptions are keyed by (user, endpoint)
// (audit M5): two accounts on one device share one endpoint, and each
// keeps its own row — subscribing as B never reassigns A's row.
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
    { user: req.user._id, endpoint: subscription.endpoint },
    {
      $set: { keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
      $setOnInsert: { user: req.user._id, endpoint: subscription.endpoint }
    },
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
