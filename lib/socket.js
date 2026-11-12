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
//   8. Screen sharing (v0.8.0): `screen-share-started` / `screen-share-stopped`
//      { roomId } claim/release the room's one share slot (lib/screenShare.js)
//      and broadcast to the room; the video itself rides the WebRTC mesh.
//      Leave / disconnect releases the sharer's slot automatically.
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
const { ROOM_FULL_MESSAGE, isRoomFull } = require('./roomCap');
const { validatePosition } = require('./proximity');
const logger = require('./logger');
const { canSeeRoom } = require('./friends');
const { createSocketRateLimiter } = require('./socketRateLimit');
const { isValidMood, normalizeMood } = require('./mood');
const {
  focusSessions, startSession, stopSession, getSession, canControlFocus,
  sessionJson
} = require('./focusSessions');
const {
  SCREEN_SHARE_BUSY_MESSAGE, createShareStore, tryClaimShare,
  releaseShare, sharerForRoom, clearSharerForSocket
} = require('./screenShare');

// Live userId -> socket id registry, so REST routes can push a
// notification to one user (friend request / room invite) without a
// room to broadcast to. In-memory like presence: a restart just clears
// it, and the next poll/refresh picks the data up again.
const userSockets = new Map(); // userId -> Set(socketId)
let ioInstance = null;
// The focus-timer clearer lives inside attachSocket (it closes over
// the timer map); this slot lets the REST routes clear a room's expiry
// timer on mode change / room delete. No-op before attachSocket runs.
let clearFocusTimerImpl = null;
const clearFocusTimer = (roomId) => {
  if (clearFocusTimerImpl) clearFocusTimerImpl(roomId);
};

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

// Emit to every socket in one room. No-op before io is attached
// (tests, boot order). REST routes call it via the exported helper —
// e.g. the room-mode route broadcasts 'room-mode-changed' to the room.
const emitToRoom = (roomId, event, payload) => {
  if (!ioInstance) return false;
  ioInstance.to(String(roomId)).emit(event, payload);
  return true;
};

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

// Screen sharing (v0.8.0): one sharer per room — the live slot map
// (lib/screenShare.js). A restart clears it, which is correct: a
// share is live state, and every client re-claims on reconnect.
// clearScreenShares is the test hook (tests seed presence directly
// and attach repeatedly in one process, like presence.clearAll).
const screenSharers = createShareStore();
const clearScreenShares = () => screenSharers.clear();

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
  // Together mode: one expiry timer per room with a live focus
  // session. When it fires, the session is cleared and 'focus-ended'
  // is broadcast to the room — that broadcast (not each client's own
  // countdown) is the authoritative end; the client's local expiry is
  // only a backstop for a missed push. The timer is unref'd so it
  // never holds the process open, and it is cleared on stop / mode
  // change / room delete (clearFocusTimer is exported for the REST
  // routes). If the session was already cleared by then, stopSession
  // returns null and nothing is broadcast.
  const focusTimers = new Map(); // roomId -> Timeout
  const clearFocusTimerForRoom = (roomId) => {
    const timer = focusTimers.get(String(roomId));
    if (timer) clearTimeout(timer);
    focusTimers.delete(String(roomId));
  };
  clearFocusTimerImpl = clearFocusTimerForRoom;
  const armFocusEnd = (roomId, session) => {
    clearFocusTimerForRoom(roomId);
    const delay = Math.max(0, session.startedAt + session.durationSec * 1000 - Date.now());
    const timer = setTimeout(() => {
      focusTimers.delete(String(roomId));
      const ended = stopSession(focusSessions, roomId);
      if (ended) io.to(String(roomId)).emit('focus-ended', sessionJson(ended));
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    focusTimers.set(String(roomId), timer);
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
      // Mood travels on the socket so presence can carry it into
      // room-state / user-joined without a second DB read per join.
      socket.user = { id: String(user._id), name: user.name, mood: normalizeMood(user.mood) };
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
        // Room cap (v0.7.0, lib/roomCap.js): at most 8 live occupants —
        // presence, not members — and no exemption for the owner or
        // moderators. A socket already in this room is not counted
        // twice, so a rejoin is never refused as the 9th person.
        // Leaving / disconnect frees the slot immediately (presence is
        // removed in leave-room and disconnect below), and a faded
        // campfire was already refused above, so the cap never
        // resurrects a gone room.
        const id = String(room._id);
        if (isRoomFull(id, socket.id)) {
          return socket.emit('error', { error: ROOM_FULL_MESSAGE, code: 'room-full' });
        }
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
        // A focus session already running in this room is shared with
        // the joiner — same startedAt + durationSec, so a late joiner
        // sees the same remaining time as everyone else. getSession
        // lazily drops an expired one, so a dead session never arrives.
        // A screen share already running is shared the same way, so a
        // late joiner knows who is sharing (the video track itself
        // arrives with the first offer, which already carries it).
        const sharer = sharerForRoom(screenSharers, id);
        const screenSharer = sharer
          ? {
            userId: sharer.userId,
            name: presence.occupants(id).find((o) => o.userId === sharer.userId)?.name || ''
          }
          : null;
        socket.emit('room-state', {
          roomId: id,
          occupants: others,
          mutedByModerator,
          focusSession: sessionJson(getSession(focusSessions, id)),
          screenSharer
        });
        socket.to(id).emit('user-joined', { socketId: socket.id, userId: user.id, name: user.name, mood: user.mood });
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
      // Leaving stops my share automatically: the slot is released
      // and the room hears 'screen-share-stopped', so no share
      // outlives its sharer and no dangling video stays on screen.
      if (releaseShare(screenSharers, id, user.id)) {
        socket.to(id).emit('screen-share-stopped', { userId: user.id, roomId: id });
      }
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

    // Screen sharing (v0.8.0): the server only relays + enforces the
    // one-sharer rule — the video itself rides the existing WebRTC
    // mesh (the track is added to each peer connection client-side).
    // Gates, in order (same H1 pattern as the signal relay):
    //   1. the socket must be IN this room (presence) — a socket that
    //      never joined cannot claim a slot in a room it is not in;
    //   2. the room must exist, be visible (not a faded campfire) and
    //      visible to this user (private rooms stay members-only).
    // A second claimant while the slot is held gets the plain 'error'
    // event with the exact message "Someone is already sharing" — the
    // client rolls its local track back on it. A successful claim (or
    // a stop by the holder) is broadcast to the whole room, including
    // the sender, so every client — including the sharer — learns the
    // slot state from the same event.
    socket.on('screen-share-started', async ({ roomId } = {}) => {
      try {
        if (!roomId) return;
        if (!rateLimiter.allow(socket.id, 'screen-share-started')) return;
        if (presence.roomOfSocket(socket.id) !== String(roomId)) return;
        const room = await Room.findById(roomId).lean();
        if (!room || !isVisible(room)) return;
        if (!canSeeRoom(room, user.id)) return;
        const res = tryClaimShare(screenSharers, String(roomId), user.id, socket.id);
        if (!res.ok) {
          return socket.emit('error', { error: SCREEN_SHARE_BUSY_MESSAGE, code: 'screen-share-busy' });
        }
        io.to(String(roomId)).emit('screen-share-started', {
          userId: user.id, name: user.name, roomId: String(roomId)
        });
      } catch (err) {
        logger.error({ err }, 'screen-share-started failed');
      }
    });

    socket.on('screen-share-stopped', ({ roomId } = {}) => {
      if (!roomId) return;
      if (!rateLimiter.allow(socket.id, 'screen-share-stopped')) return;
      if (presence.roomOfSocket(socket.id) !== String(roomId)) return;
      if (!releaseShare(screenSharers, String(roomId), user.id)) return;
      io.to(String(roomId)).emit('screen-share-stopped', { userId: user.id, roomId: String(roomId) });
    });

    // Mood glow (v0.7.0): I changed my mood — update my presence row
    // so a late joiner's room-state already carries it, and broadcast
    // the change to the room so live orbs re-glow at once. The socket
    // must be in a room (a mood sent from the lobby goes nowhere);
    // the room id comes from presence, never from the payload, so a
    // client cannot paint a mood into a room it is not in. The
    // profile PATCH (REST) is what persists the mood — this event is
    // the live half only, same split as mic-state. Rate-limited like
    // every other hot event (audit M3).
    socket.on('mood', ({ mood } = {}) => {
      if (!isValidMood(mood)) return;
      if (!rateLimiter.allow(socket.id, 'mood')) return;
      const currentRoom = presence.roomOfSocket(socket.id);
      if (!currentRoom) return;
      if (!presence.setOccupantMood(currentRoom, socket.id, mood)) return;
      socket.user.mood = mood; // a rejoin carries the new mood
      socket.to(currentRoom).emit('mood-changed', { socketId: socket.id, userId: user.id, mood });
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

    // Together mode: start/stop the room's shared focus timer.
    // Gates, in order (each failure is a silent drop or a plain
    // 'error' event — a prober learns nothing about other rooms):
    //   1. the socket must be IN this room (presence) — a socket that
    //      never joined cannot start a timer in a room it is not in;
    //   2. the room must exist, be visible (not a faded campfire) and
    //      visible to this user (private rooms stay members-only);
    //   3. the room must be a focus room — talk rooms have no timer;
    //   4. only the owner or a moderator may control it.
    // A start while one runs is a conflict ('already-running'), never
    // a second session. The H1 signal-relay check is untouched — this
    // adds events, it does not change any relay gate.
    socket.on('focus-start', async ({ roomId, durationSec } = {}) => {
      try {
        if (!roomId) return;
        if (!rateLimiter.allow(socket.id, 'focus-start')) return;
        if (presence.roomOfSocket(socket.id) !== String(roomId)) return;
        const room = await Room.findById(roomId).lean();
        if (!room || !isVisible(room)) return socket.emit('error', { error: 'Room not found' });
        if (!canSeeRoom(room, user.id)) return;
        if (room.mode !== 'focus') return socket.emit('error', { error: 'This room is not a focus room' });
        if (!canControlFocus(room, user.id)) {
          return socket.emit('error', { error: 'Only the room owner or a moderator can start the focus timer' });
        }
        const res = startSession(focusSessions, room._id, durationSec);
        if (!res.ok) {
          if (res.error === 'already-running') {
            return socket.emit('error', { error: 'A focus session is already running' });
          }
          return socket.emit('error', { error: res.error });
        }
        armFocusEnd(room._id, res.session);
        io.to(String(room._id)).emit('focus-started', {
          ...sessionJson(res.session),
          startedBy: user.id
        });
      } catch (err) {
        logger.error({ err }, 'focus-start failed');
      }
    });

    socket.on('focus-stop', async ({ roomId } = {}) => {
      try {
        if (!roomId) return;
        if (!rateLimiter.allow(socket.id, 'focus-stop')) return;
        if (presence.roomOfSocket(socket.id) !== String(roomId)) return;
        const room = await Room.findById(roomId).lean();
        if (!room || !isVisible(room)) return;
        if (!canSeeRoom(room, user.id)) return;
        if (!canControlFocus(room, user.id)) {
          return socket.emit('error', { error: 'Only the room owner or a moderator can stop the focus timer' });
        }
        const stopped = stopSession(focusSessions, room._id);
        if (!stopped) return; // nothing running — a no-op, not an error
        clearFocusTimer(room._id);
        io.to(String(room._id)).emit('focus-stopped', {
          roomId: String(room._id),
          stoppedBy: user.id
        });
      } catch (err) {
        logger.error({ err }, 'focus-stop failed');
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
        // A dropped connection counts as leaving for the share too:
        // the slot is released and the room hears it stop, so a
        // crashed sharer never leaves a stuck "sharing" state.
        const cleared = clearSharerForSocket(screenSharers, socket.id);
        if (cleared) {
          socket.to(roomId).emit('screen-share-stopped', { userId: cleared.userId, roomId });
        }
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
  attachSocket, emitToUser, emitToRoom, emitRoomsChanged, registerUserSocket, unregisterUserSocket,
  onlineUserIds, clearFocusTimer,
  isMutedInRoom, setMutedInRoom, clearMutedForRoom, kickSocketsFromRoom,
  clearScreenShares
};
