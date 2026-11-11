// Fading rooms ("campfires"): a room created as a campfire is deleted
// 60s after presence empties, unless its owner keeps it.
//
// Rules (playbook item 4 + addendum §2):
// - `Room.ephemeral` is set at creation from the create-form "Campfire"
//   toggle. `expiresAt` is a persisted BSON Date, set server-side when
//   the LAST occupant leaves (presence empties) to now + 60s. It is
//   NEVER taken from a client value and NEVER driven by a process-local
//   setTimeout: a restart must not lose the deadline, and two workers
//   must be able to run the cleanup safely.
// - Expiry means DELETE: the room document, its messages and its
//   invites go. There is no archive/tombstone (the playbook says
//   "delete the room"; postcards are a separate, later feature).
// - Expiry is enforced at READ time too (like fading chat): a room
//   whose expiresAt is at or before now stops appearing / being
//   joinable immediately, without waiting for the worker.
// - Legacy rooms with no ephemeral/expiresAt keep working — they are
//   permanent. No backfill: a deploy must never silently start
//   deleting pre-existing rooms.
// - Transitions are atomic conditional updates, so exactly one wins:
//   * arm: only when ephemeral + open + not already armed (the first
//     emptying sets the deadline; a second leave while armed keeps it).
//   * clear (rejoin): only when expiresAt is set — a rejoin before the
//     deadline cancels the fade.
//   * keep: only when ephemeral + open + not yet expired — if cleanup
//     already claimed the room, keep loses and the client gets the
//     authoritative 410.
//   * cleanup claim: only when ephemeral + open + expiresAt <= now —
//     two workers racing both find the room due, but only one claim
//     matches; the loser sees null and does nothing. Deleting a claimed
//     room checks deleteOne's deletedCount, so a crashed run's leftover
//     `closed` room is swept exactly once.
// - A restart edge, deliberately NOT handled by boot-arming: presence
//   is in-memory, so after a restart the server cannot know which
//   campfires still have people in them — and occupants do NOT
//   auto-rejoin after a restart (VoiceEngine joins once on mount), so
//   arming every campfire at boot would delete rooms people think
//   they are still in. A campfire occupied across a restart therefore
//   keeps no expiresAt until its next leave empties presence and arms
//   it. Never delete a room that might still have people in it.
//
// Pure helpers here are unit-testable without MongoDB; the DB
// transitions take the model as an argument so tests can pass stubs.

const FADE_AFTER_MS = 60 * 1000; // 60s after the last person leaves
const FADE_WORKER_INTERVAL_MS = 15 * 1000; // sweep cadence: closes 60–75s after emptying

// Server-side deadline for a room that emptied at `emptiedAt`.
const expiryFor = (emptiedAt = new Date()) =>
  new Date(new Date(emptiedAt).getTime() + FADE_AFTER_MS);

// A campfire whose deadline is at or before `now` is expired. A room
// with no expiresAt (legacy, or a campfire that is occupied / never
// emptied) is never expired.
const isExpired = (room, now = new Date()) => {
  if (!room || room.expiresAt == null) return false;
  return new Date(room.expiresAt).getTime() <= new Date(now).getTime();
};

// A room is usable when it is not expired and not already claimed by
// cleanup. Legacy rooms (no status field) are open.
const isVisible = (room, now = new Date()) =>
  !!room && room.status !== 'closed' && !isExpired(room, now);

const isCampfire = (room) => !!room && room.ephemeral === true;

// Mongo read-time filter: only rooms still alive at `now`.
// `{ expiresAt: null }` matches docs where the field is missing OR
// null, so legacy rooms stay visible; `{ $gt: now }` keeps unexpired
// ones; `status: { $ne: 'closed' }` matches missing status too, so
// pre-feature rooms pass. Combine with $and when the base query
// already has its own $or (the rooms list visibility filter).
const aliveFilter = (now = new Date()) => ({
  status: { $ne: 'closed' },
  $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date(now) } }]
});

// Filter for rooms the cleanup worker may close: campfires, not
// already closed, deadline passed.
const dueFilter = (now = new Date()) => ({
  ephemeral: true,
  status: { $ne: 'closed' },
  expiresAt: { $lte: new Date(now) }
});

// --- Atomic transitions (conditional updates; null = lost the race) ---

// Arm the fade when presence empties: set expiresAt = now + 60s, but
// only if the room is a campfire, open, and not already armed — a
// second leave while armed keeps the original deadline.
const armExpiry = (Room, roomId, now = new Date()) =>
  Room.findOneAndUpdate(
    { _id: roomId, ephemeral: true, status: { $ne: 'closed' }, expiresAt: null },
    { $set: { expiresAt: expiryFor(now) } },
    { returnDocument: 'after' }
  );

// Cancel the fade on rejoin: clear expiresAt, but only if one is set.
const clearExpiry = (Room, roomId) =>
  Room.findOneAndUpdate(
    { _id: roomId, ephemeral: true, expiresAt: { $ne: null } },
    { $unset: { expiresAt: '' } },
    { returnDocument: 'after' }
  );

// "Keep this room": make a campfire permanent. Only wins while the room
// is still an open campfire whose deadline has not passed — if cleanup
// already claimed it (or it was never a campfire), returns null and
// the caller answers 410 / no-op. Returns the updated room otherwise.
const keepRoom = (Room, roomId, now = new Date()) =>
  Room.findOneAndUpdate(
    {
      _id: roomId,
      ephemeral: true,
      status: { $ne: 'closed' },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date(now) } }]
    },
    { $set: { ephemeral: false }, $unset: { expiresAt: '' } },
    { returnDocument: 'after' }
  );

// --- Cleanup worker ---
//
// One pass: claim every due campfire with an atomic conditional update
// (only one worker can claim each room), then delete every `closed`
// room — the ones just claimed plus leftovers from a crashed run
// whose claim landed but whose delete never did. Each delete checks
// deletedCount, so two workers sweeping the same leftover delete it
// exactly once and only the deleter logs / notifies.
//
// `deps`: { Room, Message, RoomInvite, clearMutedForRoom?, onClosed?, log? }
// `onClosed(room)` fires once per deleted room (the caller emits
// `room-closed` + `rooms-changed` from it). `log` defaults to a no-op;
// pass the app logger in production — the audit line is the record
// of an unexpected closure (addendum §2).
const runCleanup = async (deps, { now = new Date() } = {}) => {
  const { Room, Message, RoomInvite, clearMutedForRoom, onClosed, log = () => {} } = deps || {};
  const at = new Date(now);
  let claimed = 0;
  const due = await Room.find(dueFilter(at));
  for (const room of due) {
    // The claim re-checks every condition: a keep or a rejoin that
    // landed after the find makes this match nothing, and null means
    // another worker (or that keep/rejoin) won — skip quietly.
    const won = await Room.findOneAndUpdate(
      { _id: room._id, ...dueFilter(at) },
      { $set: { status: 'closed', closedAt: at } },
      { returnDocument: 'after' }
    );
    if (won) claimed += 1;
  }
  let deleted = 0;
  const closed = await Room.find({ status: 'closed' });
  for (const room of closed) {
    const res = await Room.deleteOne({ _id: room._id });
    if (!res || res.deletedCount === 0) continue; // another worker deleted it
    await Message.deleteMany({ roomId: room._id });
    await RoomInvite.deleteMany({ room: room._id });
    if (clearMutedForRoom) clearMutedForRoom(room._id);
    deleted += 1;
    log({ roomId: String(room._id), roomName: room.name || '' },
      'Campfire faded — room closed and deleted');
    if (onClosed) {
      try { await onClosed(room); } catch {}
    }
  }
  return { claimed, deleted };
};

// Periodic worker: runs once immediately, then every intervalMs.
// A run that is still in flight when the next tick fires is skipped
// (no overlapping sweeps on a slow DB). Returns { stop }.
const startCleanupWorker = (deps, { intervalMs = FADE_WORKER_INTERVAL_MS } = {}) => {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runCleanup(deps);
    } catch (err) {
      (deps.log || (() => {}))({ err }, 'Campfire cleanup pass failed');
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); } };
};

module.exports = {
  FADE_AFTER_MS,
  FADE_WORKER_INTERVAL_MS,
  expiryFor,
  isExpired,
  isVisible,
  isCampfire,
  aliveFilter,
  dueFilter,
  armExpiry,
  clearExpiry,
  keepRoom,
  runCleanup,
  startCleanupWorker
};
