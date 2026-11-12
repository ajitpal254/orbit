// socket.io signaling + presence for Orbit voice rooms.
//
// Flow (mesh WebRTC, Google STUN only):
//   1. Client connects with its session cookie; we authenticate the socket
//      against the Session collection and refuse anonymous sockets.
//   2. Client emits `join-room` { roomId } -> server validates the room,
//      joins the socket.io room, sends `room-state` (current occupants) to
//      the joiner and broadcasts `user-joined` to everyone else.
//   3. The JOINER creates one RTCPeerConnection per existing occupant and
//      sends offers via `signal` { to, type: 'offer', sdp }. Existing peers
//      answer the same way. ICE candidates relay through `signal` too.
//   4. `mic-state` { roomId, muted } broadcasts mute badges for orbs.
//   5. `speaking` { roomId, speaking } updates presence so the home screen
//      can show who's talking live.
//   6. `chat-message` { roomId, text } persists the message and broadcasts
//      it to the room.
//   7. On disconnect the socket leaves every room and `user-left` fires.
const Session = require('../models/Session');
const User = require('../models/User');
const Room = require('../models/Room');
const Message = require('../models/Message');
const { hashToken } = require('../lib/passwords');
const { parseCookies } = require('../middleware/auth');
const { validateMessageInput } = require('../lib/rooms');
const { encrypt } = require('../lib/crypto');
const { withExpiry } = require('../lib/fadingChat');
const { isVisible, armExpiry, clearExpiry } = require('../lib/fadingRooms');
const presence = require('../lib/presence');
const { validatePosition } = require('./proximity');
const logger = require('./logger');
const { canSeeRoom } = require('./friends');
const { createSocketRateLimiter } = require('./socketRateLimit');

// Live userId -> socket id registry, so REST routes can push a
// notification to one user (friend request / room invite) without a
// room to broadcast to. In-memory like presence: a restart just clears
// it, and the next poll/refresh picks the data up again.
const userSockets = new Map(); // userId -> Set(socketId)
let ioInstance = null;

const registerUserSocket = (userId, socketId) => {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socketId);
};

const unregisterUserSocket = (userId, socketId) => {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) userSockets.delete(userId);
};

// Emit to every connected socket of one user. No-op when they are offline
// or the server hasn't attached socket.io yet (tests, boot order).
const emitToUser = (userId, event, payload) => {
  if (!ioInstance) return 0;
  const set = userSockets.get(String(userId));
  if (!set) return 0;
  let sent = 0;
  for (const socketId of set) {
    ioInstance.to(socketId).emit(event, payload);
    sent += 1;
  }
  return sent;
};

// The user ids with at least one live socket right now — the
// friends-presence route's "online" signal. A restart clears the
// registry, which is correct: presence is ephemeral.
const onlineUserIds = () => new Set(userSockets.keys());

// Tell every connected client the room list changed (someone joined,
// left, or a room was created/deleted) so home screens refresh live
// from this push instead of polling. No-op before io is attached
// (tests, boot order). REST routes call it via the exported helper.
const emitRoomsChanged = (roomId) => {
  if (!ioInstance) return false;
  ioInstance.emit('rooms-changed', { roomId: roomId ? String(roomId) : null });
  return true;
};

// Moderator mutes, per room: roomId -> Set(userId). In-memory like
// presence — a restart clears it, and a moderator can re-mute. Voice is
// P2P so this is COOPERATIVE: the server cannot force a client to stop
// sending audio; the target client honors `moderator-muted` by muting
// itself, and re-applies it on rejoin (see join-room below).
const mutedByRoom = new Map(); // roomId -> Set(userId)

const isMutedInRoom = (roomId, userId) =>
  !!mutedByRoom.get(String(roomId))?.has(String(userId));

const setMutedInRoom = (roomId, userId, muted) => {
  const id = String(roomId);
  if (muted) {
    if (!mutedByRoom.has(id)) mutedByRoom.set(id, new Set());
    mutedByRoom.get(id).add(String(userId));
  } else {
    mutedByRoom.get(id)?.delete(String(userId));
    if (mutedByRoom.get(id)?.size === 0) mutedByRoom.delete(id);
  }
};

const clearMutedForRoom = (roomId) => mutedByRoom.delete(String(roomId));

// Force a user's sockets out of a room's socket.io room and tell their
// client it was kicked (their RoomView leaves on `room-kicked`). The REST
// kick route calls this after removing them from members, so a kicked
// socket cannot keep receiving chat or signals for the room.
const kickSocketsFromRoom = (userId, roomId) => {
  if (!ioInstance) return 0;
  const set = userSockets.get(String(userId));
  if (!set) return 0;
  const room = String(roomId);
  let kicked = 0;
  const allSockets = ioInstance.sockets?.sockets;
  for (const socketId of set) {
    const socket = allSockets?.get?.(socketId);
    if (socket) {
      try { socket.leave(room); } catch {}
      kicked += 1;
    }
  }
  if (kicked > 0) emitToUser(userId, 'room-kicked', { roomId: room });
  return kicked;
};

const attachSocket = (io) => {
  ioInstance = io;
  // M3: per-socket token buckets on the hot events. Dropped events are
  // warned about at most once per 10s per socket+event (see
  // lib/socketRateLimit.js) so a flood cannot turn into log spam.
  const rateLimiter = createSocketRateLimiter({
    onLimited: ({ socketId, event }) =>
      logger.warn({ socketId, event }, 'Socket rate limit exceeded, dropping event')
  });
  // H1: may this socket signal that socket? Both must be in the same
  // room right now (presence), AND both must be allowed in it (the
  // room's member list, via the same canSeeRoom gate join-room uses).
  // Presence alone is not enough: a kicked socket's presence can go
  // stale when its client never emits leave-room, so the member list is
  // the backstop. Public rooms pass canSeeRoom for any occupant; private
  // rooms need membership. Anything failing the check is dropped
  // silently — no error event, so a prober learns nothing.
  const canRelaySignal = async (fromSocket, toSocketId) => {
    const roomId = presence.roomOfSocket(fromSocket.id);
    if (!roomId) return false;
    if (presence.roomOfSocket(toSocketId) !== roomId) return false;
    const room = await Room.findById(roomId).lean();
    if (!room || !isVisible(room)) return false;
    const target = presence.occupants(roomId).find((o) => o.socketId === toSocketId);
    if (!target) return false;
    return canSeeRoom(room, fromSocket.user.id) && canSeeRoom(room, target.userId);
  };
  // Authenticate every socket from its session cookie.
  io.use(async (socket, next) => {
    try {
      const token = parseCookies(socket.handshake.headers.cookie).sessionToken;
      if (!token) return next(new Error('Not authenticated'));
      const session = await Session.findOne({ tokenHash: hashToken(token) });
      if (!session || session.expiresAt < new Date()) return next(new Error('Session expired'));
      const user = await User.findById(session.userId);
      if (!user) return next(new Error('User not found'));
      socket.user = { id: String(user._id), name: user.name };
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    registerUserSocket(user.id, socket.id);
    logger.debug({ socketId: socket.id, userId: user.id }, 'Socket connected');

    socket.on('join-room', async ({ roomId } = {}) => {
      try {
        // .lean(): room members may be legacy plain ObjectIds, which a
        // hydrated document would mangle under the subdocument schema
        // (see lib/roles.js) — raw values only.
        const room = await Room.findById(roomId).lean();
        if (!room) return socket.emit('error', { error: 'Room not found' });
        // A faded campfire is gone even if the cleanup worker has not
        // swept it yet — expiry is enforced at read time.
        if (!isVisible(room)) {
          return socket.emit('error', { error: 'This campfire has faded' });
        }
        // Private rooms are members-only — refuse before joining, so a
        // non-member never gets room-state or a voice path in.
        if (!canSeeRoom(room, user.id)) {
          return socket.emit('error', { error: 'This room is private' });
        }
        const id = String(room._id);
        socket.join(id);
        presence.addOccupant(id, socket.id, user);
        // A rejoin before the deadline cancels the fade (atomic: only
        // clears when an expiry is actually armed). Fire-and-forget —
        // the join itself must not fail on a slow DB write.
        if (room.ephemeral) clearExpiry(Room, id).catch((err) => logger.error({ err }, 'clearExpiry failed'));
        // Occupants for the joiner (excluding self — they create the offers).
        const others = presence.occupants(id).filter((o) => o.socketId !== socket.id);
        // A moderator-muted user rejoining starts muted again.
        const mutedByModerator = isMutedInRoom(id, user.id);
        socket.emit('room-state', { roomId: id, occupants: others, mutedByModerator });
        socket.to(id).emit('user-joined', { socketId: socket.id, userId: user.id, name: user.name });
        emitRoomsChanged(id); // home screens refresh occupancy live
        logger.debug({ socketId: socket.id, roomId: id }, 'Joined room');
      } catch (err) {
        logger.error({ err }, 'join-room failed');
        socket.emit('error', { error: 'Could not join room' });
      }
    });

    socket.on('leave-room', ({ roomId } = {}) => {
      if (!roomId) return;
      const id = String(roomId);
      socket.leave(id);
      presence.removeOccupant(id, socket.id);
      socket.to(id).emit('user-left', { socketId: socket.id, userId: user.id });
      emitRoomsChanged(id);
      // Last person out of a campfire arms the 60s fade (persisted
      // expiresAt — not a timer, so a restart cannot lose it). The
      // conditional update is a no-op for permanent rooms and for a
      // room that is already armed.
      if (presence.occupancyCount(id) === 0) {
        armExpiry(Room, id).catch((err) => logger.error({ err }, 'armExpiry failed'));
      }
    });

    // Relay WebRTC signaling to one peer. `to` is the target socket id.
    // H1: only between two sockets in the same room that are both allowed
    // in it — anything else (a socket that never joined, a kicked
    // non-member, a cross-room target) is dropped silently. M3: signals
    // are rate-limited first, so a flood never reaches the relay check.
    socket.on('signal', async ({ to, type, data } = {}) => {
      try {
        if (!to || !type) return;
        if (!rateLimiter.allow(socket.id, 'signal')) return;
        if (!(await canRelaySignal(socket, to))) return;
        io.to(to).emit('signal', { from: socket.id, type, data });
      } catch (err) {
        logger.error({ err }, 'signal relay failed');
      }
    });

    socket.on('mic-state', ({ roomId, muted } = {}) => {
      if (!roomId) return;
      if (!rateLimiter.allow(socket.id, 'mic-state')) return;
      socket.to(String(roomId)).emit('mic-state', { socketId: socket.id, userId: user.id, muted: Boolean(muted) });
    });

    socket.on('speaking', ({ roomId, speaking } = {}) => {
      if (!roomId) return;
      if (!rateLimiter.allow(socket.id, 'speaking')) return;
      presence.setSpeaking(String(roomId), socket.id, speaking);
    });

    // Proximity audio (v0.6.0): a member drags their orb, the client
    // broadcasts its position, and the server relays the clamped
    // position to the rest of the room so every client can set the
    // speaker's gain from the distance. Membership is enforced the
    // same way as the H1 signal relay: the socket must be in a room
    // (presence) AND allowed in it (canSeeRoom backstop — a kicked
    // socket with stale presence is refused), and a payload naming a
    // different room than the socket is in is dropped. Positions are
    // validated + clamped server-side (lib/proximity.js) and never
    // logged. Rate-limited first, like every other hot event.
    socket.on('orb-move', async ({ roomId, x, y } = {}) => {
      try {
        if (!rateLimiter.allow(socket.id, 'orb-move')) return;
        const currentRoom = presence.roomOfSocket(socket.id);
        if (!currentRoom) return;
        if (roomId && String(roomId) !== currentRoom) return;
        const room = await Room.findById(currentRoom).lean();
        if (!room || !isVisible(room)) return;
        if (!canSeeRoom(room, user.id)) return;
        const pos = validatePosition({ x, y });
        if (!pos.ok) return;
        socket.to(currentRoom).emit('orb-move', {
          socketId: socket.id, userId: user.id, x: pos.x, y: pos.y
        });
      } catch (err) {
        logger.error({ err }, 'orb-move failed');
      }
    });

    socket.on('chat-message', async ({ roomId, text } = {}) => {
      try {
        if (!roomId) return;
        if (!rateLimiter.allow(socket.id, 'chat-message')) return;
        // .lean() — see join-room: legacy member shapes must stay raw.
        const room = await Room.findById(roomId).lean();
        if (!room) return;
        // A socket that never joined (or was refused from a private room)
        // must not be able to post into it — and a faded campfire
        // takes no more messages.
        if (!isVisible(room)) return;
        if (!canSeeRoom(room, user.id)) return;
        const { ok, text: clean } = validateMessageInput({ text });
        if (!ok) return;
        const msg = await Message.create(withExpiry({
          roomId: room._id, userId: user.id, name: user.name,
          // Stored encrypted; the broadcast below sends the plaintext to
          // room members over their own TLS/WSS connection — that is correct.
          text: encrypt(clean)
        }));
        const payload = {
          id: String(msg._id), roomId: String(msg.roomId),
          userId: user.id, name: user.name, text: clean, createdAt: msg.createdAt
        };
        io.to(String(room._id)).emit('chat-message', payload);
      } catch (err) {
        logger.error({ err }, 'chat-message failed');
      }
    });

    socket.on('disconnect', () => {
      unregisterUserSocket(user.id, socket.id);
      rateLimiter.dropSocket(socket.id);
      const left = presence.removeSocketEverywhere(socket.id);
      for (const roomId of left) {
        socket.to(roomId).emit('user-left', { socketId: socket.id, userId: user.id });
        emitRoomsChanged(roomId);
        // Same arm-on-empty as leave-room: a dropped connection counts
        // as leaving for the fade.
        if (presence.occupancyCount(roomId) === 0) {
          armExpiry(Room, roomId).catch((err) => logger.error({ err }, 'armExpiry failed'));
        }
      }
      logger.debug({ socketId: socket.id }, 'Socket disconnected');
    });
  });

  return io;
};

module.exports = {
  attachSocket, emitToUser, emitRoomsChanged, registerUserSocket, unregisterUserSocket,
  onlineUserIds,
  isMutedInRoom, setMutedInRoom, clearMutedForRoom, kickSocketsFromRoom
};
