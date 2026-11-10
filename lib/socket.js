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
const presence = require('../lib/presence');
const logger = require('./logger');

const attachSocket = (io) => {
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
    logger.debug({ socketId: socket.id, userId: user.id }, 'Socket connected');

    socket.on('join-room', async ({ roomId } = {}) => {
      try {
        const room = await Room.findById(roomId);
        if (!room) return socket.emit('error', { error: 'Room not found' });
        const id = String(room._id);
        socket.join(id);
        presence.addOccupant(id, socket.id, user);
        // Occupants for the joiner (excluding self — they create the offers).
        const others = presence.occupants(id).filter((o) => o.socketId !== socket.id);
        socket.emit('room-state', { roomId: id, occupants: others });
        socket.to(id).emit('user-joined', { socketId: socket.id, userId: user.id, name: user.name });
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
    });

    // Relay WebRTC signaling to one peer. `to` is the target socket id.
    socket.on('signal', ({ to, type, data } = {}) => {
      if (!to || !type) return;
      io.to(to).emit('signal', { from: socket.id, type, data });
    });

    socket.on('mic-state', ({ roomId, muted } = {}) => {
      if (!roomId) return;
      socket.to(String(roomId)).emit('mic-state', { socketId: socket.id, userId: user.id, muted: Boolean(muted) });
    });

    socket.on('speaking', ({ roomId, speaking } = {}) => {
      if (!roomId) return;
      presence.setSpeaking(String(roomId), socket.id, speaking);
    });

    socket.on('chat-message', async ({ roomId, text } = {}) => {
      try {
        if (!roomId) return;
        const room = await Room.findById(roomId);
        if (!room) return;
        const { ok, text: clean } = validateMessageInput({ text });
        if (!ok) return;
        const msg = await Message.create({
          roomId: room._id, userId: user.id, name: user.name, text: clean
        });
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
      const left = presence.removeSocketEverywhere(socket.id);
      for (const roomId of left) {
        socket.to(roomId).emit('user-left', { socketId: socket.id, userId: user.id });
      }
      logger.debug({ socketId: socket.id }, 'Socket disconnected');
    });
  });

  return io;
};

module.exports = { attachSocket };
