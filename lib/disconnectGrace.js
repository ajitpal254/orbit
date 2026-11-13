// Disconnect grace: a socket that drops out of a room is not gone at
// once. The server waits DISCONNECT_GRACE_MS before telling the room
// it left, so a brief network blip or a refresh is invisible instead
// of showing "X left" and "X joined" seconds apart. A reconnect (or a
// confirmed tab close via the leave-beacon) settles the timer early:
// the reconnect cancels it and fires the departure for the dead
// sockets at once; the beacon does the same.
//
// Pure registry — no socket.io, no DB — so tests drive it with fake
// timers. One entry per (user, room): a second drop while one is
// pending merges its socket into the same entry instead of arming a
// second timer, so a reconnect settles every dead socket of that user
// in that room at once. Presence is NOT touched here: the caller
// removes the socket from presence at disconnect time (presence is
// socket truth); this registry only defers the notifications + side
// effects (user-left, share release, rooms-changed, fade arming).

const DISCONNECT_GRACE_MS = 15000;

function graceKey(userId, roomId) {
  return `${String(userId)}:${String(roomId)}`;
}

function createDisconnectGrace({
  graceMs = DISCONNECT_GRACE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  const pending = new Map(); // key -> { userId, roomId, socketIds: Set, onExpire, timer }

  // Arm the grace for one socket's departure. A second arm for the
  // same (user, room) merges into the pending entry — same timer,
  // both sockets depart together when it fires.
  const arm = (userId, roomId, socketId, onExpire) => {
    const key = graceKey(userId, roomId);
    const existing = pending.get(key);
    if (existing) {
      existing.socketIds.add(String(socketId));
      return existing;
    }
    const entry = {
      userId: String(userId),
      roomId: String(roomId),
      socketIds: new Set([String(socketId)]),
      onExpire,
      timer: null
    };
    entry.timer = setTimeoutFn(() => {
      pending.delete(key);
      entry.onExpire({
        userId: entry.userId,
        roomId: entry.roomId,
        socketIds: [...entry.socketIds]
      });
    }, graceMs);
    if (typeof entry.timer?.unref === 'function') entry.timer.unref();
    pending.set(key, entry);
    return entry;
  };

  // Cancel without firing. Returns the entry ({ userId, roomId,
  // socketIds }) so the caller can still settle its sockets — a
  // reconnect fires their departure at once instead of waiting out
  // the grace — or null when nothing was pending.
  const cancel = (userId, roomId) => {
    const key = graceKey(userId, roomId);
    const entry = pending.get(key);
    if (!entry) return null;
    clearTimeoutFn(entry.timer);
    pending.delete(key);
    return { userId: entry.userId, roomId: entry.roomId, socketIds: [...entry.socketIds] };
  };

  const has = (userId, roomId) => pending.has(graceKey(userId, roomId));
  const pendingCount = () => pending.size;

  const clearAll = () => {
    for (const entry of pending.values()) clearTimeoutFn(entry.timer);
    pending.clear();
  };

  return { arm, cancel, has, pendingCount, clearAll };
}

module.exports = { DISCONNECT_GRACE_MS, graceKey, createDisconnectGrace };
