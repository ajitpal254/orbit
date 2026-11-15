// Music idle auto-disconnect (v0.10.0): if music is ACTIVE and the
// DJ is ALONE in the room (no other listeners), the DJ's browser is
// playing to nobody. Start a 5-minute timer; a listener joining
// cancels it. At 4 minutes the room gets a `music-idle-warning`
// (1 minute remaining); at 5 minutes the DJ role is released and
// playback stops (`music-idle-disconnect` + a fresh `music-state`).
// The queue PERSISTS — the next DJ resumes, exactly like a DJ leave.
//
// Pure registry — no socket.io, no DB — so tests drive it with fake
// timers (same pattern as lib/disconnectGrace.js). The timer
// functions and the durations are injectable; the callbacks
// (onWarning / onTimeout) are the socket layer's broadcasts, so this
// module never emits anything itself. One entry per room: a second
// evaluate while one is pending is a no-op (the 5 minutes run from
// when the DJ became alone, not from the last queue edit), and an
// evaluate with the room no longer alone-or-active cancels it.
//
// "Active" and "alone" are the caller's call (lib/musicQueue.js
// isMusicActive + the presence occupant list) — this module only
// owns the clocks.

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes alone, then stop
const IDLE_WARNING_MS = 4 * 60 * 1000; // warn at 4 minutes (1 min left)
const IDLE_WARNING_SECONDS_REMAINING = 60;

const createMusicIdle = ({
  timeoutMs = IDLE_TIMEOUT_MS,
  warningMs = IDLE_WARNING_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onWarning = null,
  onTimeout = null
} = {}) => {
  const pending = new Map(); // roomId -> { warningTimer, disconnectTimer }

  // Cancel the room's timers without firing. Returns true when a
  // timer was pending.
  const cancel = (roomId) => {
    const id = String(roomId);
    const entry = pending.get(id);
    if (!entry) return false;
    if (entry.warningTimer != null) clearTimeoutFn(entry.warningTimer);
    if (entry.disconnectTimer != null) clearTimeoutFn(entry.disconnectTimer);
    pending.delete(id);
    return true;
  };

  // Re-evaluate the room: start the timer when alone + active, keep
  // a running one as-is, cancel when the room is no longer
  // alone-or-active. Returns true when a timer is pending afterwards.
  const evaluate = (roomId, { active, alone } = {}) => {
    const id = String(roomId);
    if (!active || !alone) return cancel(id), pending.has(id);
    if (pending.has(id)) return true; // already counting down
    const entry = { warningTimer: null, disconnectTimer: null };
    pending.set(id, entry);
    const armDisconnect = () => {
      const remainingMs = Math.max(0, timeoutMs - warningMs);
      entry.disconnectTimer = setTimeoutFn(() => {
        pending.delete(id);
        if (onTimeout) onTimeout(id);
      }, remainingMs);
      if (typeof entry.disconnectTimer?.unref === 'function') entry.disconnectTimer.unref();
    };
    entry.warningTimer = setTimeoutFn(() => {
      entry.warningTimer = null;
      if (onWarning) onWarning(id);
      armDisconnect();
    }, warningMs);
    if (typeof entry.warningTimer?.unref === 'function') entry.warningTimer.unref();
    return true;
  };

  const has = (roomId) => pending.has(String(roomId));
  const pendingCount = () => pending.size;

  // Never leave a dangling timer: clear every room's timers
  // (shutdown / tests). The disconnect callbacks do NOT fire.
  const clearAll = () => {
    for (const roomId of [...pending.keys()]) cancel(roomId);
  };

  return { evaluate, cancel, has, pendingCount, clearAll };
};

module.exports = {
  IDLE_TIMEOUT_MS,
  IDLE_WARNING_MS,
  IDLE_WARNING_SECONDS_REMAINING,
  createMusicIdle
};
