// Atomic member-list mutations (audit M4).
//
// The old writeMembers() did read-then-$set: it loaded the member
// list, edited it in memory, and rewrote the whole array. Two
// concurrent operations interleaved — A reads [X, Y], B reads
// [X, Y], A adds Z and writes [X, Y, Z], B kicks Y and writes [X]
// — and Z was silently lost; in the other order the kick was undone
// and the kicked user was silently reinstated.
//
// Every helper here is a SINGLE atomic MongoDB operation, so no
// interleaving can lose an effect:
//   - addMember: $addToSet guarded by a $ne filter (an existing
//     member is never duplicated; matchedCount 0 means "already a
//     member").
//   - removeMember: one aggregation-pipeline update ($filter) that
//     removes both member shapes in one step.
//   - setMemberRole / transferOwnership: findOneAndUpdate whose
//     filter requires the EXPECTED current role (optimistic
//     concurrency) — a concurrent role change or kick wins exactly
//     once and the loser gets null instead of overwriting.
//
// Member shapes: rooms created after roles exist store subdocuments
// { user, role }; older rooms store plain ObjectIds (implicit
// 'member', creator implicit 'owner' — see lib/roles.js
// normalizeMembers). The operators handle BOTH shapes: filters use
// $elemMatch on the subdocument shape plus $elemMatch/$eq on the
// plain-id shape, and pipeline rewrites use $ifNull so a plain id
// becomes { user: <the id>, role } instead of { user: null }.
//
// All helpers take the Room model as the first argument so tests can
// pass it in directly; callers pass ObjectIds or hex strings.
const mongoose = require('mongoose');

const toObjectId = (v) =>
  v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(v);

// Add a member — $addToSet, so a concurrent duplicate add cannot
// create two entries. The $ne filter makes matchedCount 0 when the
// user is already a member (subdocument shape); a legacy plain-id
// entry does not block the add, but normalizeMembers() de-duplicates
// by user id, so the member still appears exactly once.
const addMember = (Room, roomId, userId, role = 'member') =>
  Room.updateOne(
    { _id: roomId, 'members.user': { $ne: toObjectId(userId) } },
    { $addToSet: { members: { user: toObjectId(userId), role } } }
  );

// Remove a member — one pipeline update, both shapes at once. Two
// sequential $pulls (one per shape) would leave a window where a
// concurrent add could land between them and be silently undone by
// the second pull — or a kick could be undone by an add landing
// between them. A single $filter has no window.
//
// opts.soleMemberOnly: the update only matches while the room has
// exactly one member. Used when the room OWNER leaves: the owner may
// leave only as the sole member, and the removal must be conditional
// on that still being true — otherwise a member who joins between
// the canLeave check and this update would leave the room ownerless.
const removeMember = (Room, roomId, userId, { soleMemberOnly = false } = {}) => {
  const uid = toObjectId(userId);
  const filter = { _id: roomId };
  if (soleMemberOnly) filter.members = { $size: 1 };
  return Room.updateOne(filter, [
    { $set: { members: { $filter: {
      input: '$members', as: 'm',
      cond: { $not: { $or: [
        { $eq: ['$$m.user', uid] },
        { $eq: ['$$m', uid] }
      ] } }
    } } } }
  ], { updatePipeline: true });
};

// Change one member's role — the filter requires the member to
// CURRENTLY hold fromRole, so a concurrent role change (or a kick)
// wins exactly once and the loser gets null. Returns the updated
// room document, or null when the expected state no longer holds.
// A legacy plain-id entry counts as role 'member' (its only possible
// role), so promoting one rewrites it into a subdocument.
const setMemberRole = (Room, roomId, userId, fromRole, toRole) => {
  const uid = toObjectId(userId);
  const filter = { _id: roomId, $or: [
    { members: { $elemMatch: { user: uid, role: fromRole } } }
  ] };
  if (fromRole === 'member') {
    filter.$or.push({ members: { $elemMatch: { $eq: uid } } });
  }
  return Room.findOneAndUpdate(filter, [
    { $set: { members: { $map: {
      input: '$members', as: 'm',
      in: { $cond: [
        { $or: [{ $eq: ['$$m.user', uid] }, { $eq: ['$$m', uid] }] },
        { user: { $ifNull: ['$$m.user', '$$m'] }, role: toRole },
        '$$m'
      ] }
    } } } }
  ], { returnDocument: 'after', updatePipeline: true });
};

// Transfer ownership — ONE update: createdBy moves and both role
// entries flip together, gated on the actor currently being the
// owner and the target currently being a member or moderator (either
// shape). The actor filter also accepts a legacy plain-id creator
// (the creator is the owner even though the stored entry has no
// role). Returns the updated room, or null when the expected state
// no longer holds (a concurrent transfer already moved ownership).
const transferOwnership = (Room, roomId, actorId, targetId) => {
  const actor = toObjectId(actorId);
  const target = toObjectId(targetId);
  return Room.findOneAndUpdate(
    { _id: roomId, $and: [
      { $or: [
        { members: { $elemMatch: { user: actor, role: 'owner' } } },
        { createdBy: actor, members: { $elemMatch: { $eq: actor } } }
      ] },
      { $or: [
        { members: { $elemMatch: { user: target, role: { $in: ['member', 'moderator'] } } } },
        { members: { $elemMatch: { $eq: target } } }
      ] }
    ] },
    [{ $set: {
      createdBy: target,
      members: { $map: {
        input: '$members', as: 'm',
        in: { $cond: [
          { $or: [{ $eq: ['$$m.user', target] }, { $eq: ['$$m', target] }] },
          { user: { $ifNull: ['$$m.user', '$$m'] }, role: 'owner' },
          { $cond: [
            { $or: [{ $eq: ['$$m.user', actor] }, { $eq: ['$$m', actor] }] },
            { user: { $ifNull: ['$$m.user', '$$m'] }, role: 'moderator' },
            '$$m'
          ] }
        ] }
      } }
    } }],
    { returnDocument: 'after', updatePipeline: true }
  );
};

module.exports = { addMember, removeMember, setMemberRole, transferOwnership };
