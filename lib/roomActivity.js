// Room activity recency (v0.9.0, density): the data behind the
// "Recently quiet" row and the streak strip.
//
//   touchRoomActivity(roomId) — stamp a room's lastActiveAt to now.
//     Fire-and-forget: recency is display data, so a slow or failed
//     write must never fail the message send or voice join that
//     triggered it. Never throws, never awaits.
//   activeDaysFromTimestamps(timestamps, now) — pure: bucket message
//     timestamps into the UTC calendar days they fall on, limited to
//     the last 7 days (today included). Powers GET /api/me/activity.
//
// A room with no lastActiveAt (created before v0.9.0) reads as active
// at its createdAt — see activityStats.roomLastActive on the client.
const Room = require('../models/Room');

const DAY_MS = 24 * 60 * 60 * 1000;

const utcDayString = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const touchRoomActivity = (roomId) => {
  if (!roomId) return;
  Room.updateOne({ _id: roomId }, { $set: { lastActiveAt: new Date() } })
    .exec()
    .catch(() => {});
};

const activeDaysFromTimestamps = (timestamps, now = new Date()) => {
  const end = now instanceof Date ? now : new Date(now);
  // The window is calendar days, not milliseconds: a message from
  // 00:30 on the 7th day back still counts for that day, even though
  // it is a few minutes past "now minus 6 days". Build the allowed
  // set of day strings (today + the 6 days before it, UTC) and keep
  // only timestamps that land on one of them.
  const allowed = new Set();
  for (let i = 0; i < 7; i += 1) {
    allowed.add(utcDayString(new Date(end.getTime() - i * DAY_MS)));
  }
  const days = new Set();
  for (const ts of timestamps || []) {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const day = utcDayString(d);
    if (day && allowed.has(day)) days.add(day);
  }
  return [...days].sort();
};

module.exports = { touchRoomActivity, activeDaysFromTimestamps, utcDayString, DAY_MS };
