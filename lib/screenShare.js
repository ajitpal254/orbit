// Screen sharing — one sharer per room (v0.8.0).
//
// Pure + testable: the registry is a Map injected by the caller
// (roomId -> { userId, socketId }), so unit tests get a fresh one and
// the server (lib/socket.js) passes its module-level map. No socket.io,
// no DB, no timers — the socket layer owns the broadcast, this module
// only decides who holds the single share slot.
//
// One sharer at a time, per room: a second person trying to share
// while a slot is held gets { ok: false, error: SCREEN_SHARE_BUSY_MESSAGE }
// and the socket layer turns that into the client's 'error' event with
// the exact message the spec requires: "Someone is already sharing".
// The same user re-claiming (a re-emitted started event, a second tab)
// is idempotent — the slot just follows their newest socket.
// A share dies with the sharer: leave-room / disconnect clears the
// slot (clearSharerForSocket) so no room is ever stuck "sharing" with
// nobody in it.

const SCREEN_SHARE_BUSY_MESSAGE = 'Someone is already sharing';

const createShareStore = () => new Map();

// Claim the room's share slot for (userId, socketId). Returns
// { ok: true } on success (including a re-claim by the current sharer),
// or { ok: false, error, sharerUserId } when someone else holds it.
const tryClaimShare = (sharers, roomId, userId, socketId) => {
  const id = String(roomId);
  const current = sharers.get(id);
  if (current && String(current.userId) !== String(userId)) {
    return { ok: false, error: SCREEN_SHARE_BUSY_MESSAGE, sharerUserId: current.userId };
  }
  sharers.set(id, { userId: String(userId), socketId: String(socketId) });
  return { ok: true };
};

// Release the slot, but only when it belongs to this user — a
// non-sharer stopping (or a stale stop after a takeover) must never
// clear someone else's share. Returns true when a slot was released.
const releaseShare = (sharers, roomId, userId) => {
  const id = String(roomId);
  const current = sharers.get(id);
  if (!current || String(current.userId) !== String(userId)) return false;
  sharers.delete(id);
  return true;
};

// Who holds the slot in this room, or null when nobody is sharing.
const sharerForRoom = (sharers, roomId) => {
  const current = sharers.get(String(roomId));
  return current ? { userId: current.userId, socketId: current.socketId } : null;
};

// The sharer is leaving (leave-room / disconnect): drop whatever slot
// their socket holds, in whatever room it was. Returns
// { roomId, userId } when a slot was cleared, else null — the caller
// broadcasts 'screen-share-stopped' to that room only when non-null.
const clearSharerForSocket = (sharers, socketId) => {
  for (const [roomId, current] of sharers) {
    if (String(current.socketId) === String(socketId)) {
      sharers.delete(roomId);
      return { roomId, userId: current.userId };
    }
  }
  return null;
};

module.exports = {
  SCREEN_SHARE_BUSY_MESSAGE,
  createShareStore,
  tryClaimShare,
  releaseShare,
  sharerForRoom,
  clearSharerForSocket
};
