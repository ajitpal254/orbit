// Pure role helpers for private rooms. No DB access here so these are
// unit-testable without MongoDB.
//
// Members are stored as subdocuments { user, role } with role 'owner' |
// 'moderator' | 'member' — but rooms created before roles existed store
// plain ObjectIds. normalizeMembers hides that: a plain ObjectId is a
// 'member', and the creator is always 'owner' even if their entry is
// missing or says otherwise. Ids may be ObjectIds or strings —
// everything is compared as strings.
//
// Roles apply to PRIVATE rooms only. Public rooms have no members list;
// their creator keeps delete-only, exactly as before.
//
// WARNING: never read a legacy room's members through a hydrated Mongoose
// document — Mongoose 9 casts plain ObjectIds into subdocuments and the
// user id is lost (the bytes become junk fields). Always use .lean() for
// room reads, then normalize here. normalizeMembers also drops any entry
// it cannot resolve to a user id, so a mangled entry degrades to
// "creator is owner, everyone else unknown" instead of crashing.
const s = (v) => String(v);

// The user id of one member entry, or null when it cannot be resolved:
//   - plain ObjectId / string            -> itself
//   - subdocument { user, role }         -> user (ObjectId, string, or a
//                                           populated User doc { _id, name })
//   - populated legacy User doc {_id,...} -> _id
const entryUserId = (m) => {
  if (m == null) return null;
  if (typeof m !== 'object') {
    // A bare id is only valid when it looks like an ObjectId — a junk
    // string is not a user.
    return typeof m === 'string' && /^[0-9a-f]{24}$/i.test(m) ? m : null;
  }
  if ('user' in m || 'role' in m) {
    const u = m.user;
    if (u == null) return null;
    if (typeof u === 'object') return u._id ? s(u._id) : null;
    return typeof u === 'string' && /^[0-9a-f]{24}$/i.test(u) ? u : null;
  }
  if (m._id) return s(m._id);
  return null;
};

// Normalized members: [{ userId, role }], de-duplicated, creator forced
// to 'owner', creator added when missing from the list.
const normalizeMembers = (room) => {
  if (!room) return [];
  const creator = room.createdBy ? s(room.createdBy) : null;
  const seen = new Set();
  const out = [];
  for (const m of room.members || []) {
    const userId = entryUserId(m);
    if (!userId || userId === 'undefined' || seen.has(userId)) continue;
    seen.add(userId);
    const role = m && typeof m === 'object' && typeof m.role === 'string' ? m.role : 'member';
    out.push({ userId, role: creator === userId ? 'owner' : role });
  }
  if (creator && !seen.has(creator)) out.unshift({ userId: creator, role: 'owner' });
  return out;
};

// 'owner' | 'moderator' | 'member' | null (null = not a member).
const getRole = (room, userId) => {
  if (!room || userId == null) return null;
  const entry = normalizeMembers(room).find((m) => m.userId === s(userId));
  return entry ? entry.role : null;
};

// Permission predicates. All take the normalized view, so they work for
// both member shapes. actorId === targetId is never an admin action on
// someone else — the routes reject self-targeting separately where it
// would be a no-op (promote/demote/transfer to self).
const canPromote = (room, actorId, targetId) =>
  getRole(room, actorId) === 'owner' && getRole(room, targetId) === 'member';

const canDemote = (room, actorId, targetId) =>
  getRole(room, actorId) === 'owner' && getRole(room, targetId) === 'moderator';

const canKick = (room, actorId, targetId) => {
  if (s(actorId) === s(targetId)) return false;
  const actor = getRole(room, actorId);
  const target = getRole(room, targetId);
  if (!actor || !target) return false;
  if (actor === 'owner') return true;
  if (actor === 'moderator') return target === 'member';
  return false;
};

const canMute = (room, actorId, targetId) => {
  if (s(actorId) === s(targetId)) return false;
  const actor = getRole(room, actorId);
  const target = getRole(room, targetId);
  if (!actor || !target) return false;
  if (target === 'owner') return false;
  if (actor === 'owner') return true;
  // A moderator mutes members only — not the owner, not other moderators.
  if (actor === 'moderator') return target === 'member';
  return false;
};

const canTransfer = (room, actorId, targetId) => {
  if (s(actorId) === s(targetId)) return false;
  const target = getRole(room, targetId);
  return getRole(room, actorId) === 'owner' && (target === 'member' || target === 'moderator');
};

// Can userId leave the room? The owner of a non-empty private room
// cannot leave until ownership is transferred; everyone else can, and
// the owner alone in the room can leave (the room is deleted then).
const canLeave = (room, userId) => {
  const role = getRole(room, userId);
  if (!role) return false; // not a member — nothing to leave
  if (role !== 'owner') return true;
  return normalizeMembers(room).length <= 1;
};

module.exports = {
  normalizeMembers, getRole,
  canPromote, canDemote, canKick, canMute, canTransfer, canLeave
};
