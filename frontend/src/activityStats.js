// Activity stats for the v0.9.0 density strips (pure, unit-tested in
// tests/activityStats.test.mjs). No fetching here — callers pass the
// data Home already loads (GET /api/rooms, GET /api/me/activity).
//
//   weekActivity(dayStrings, now) — the streak strip: how many of the
//     last 7 UTC days the user was active (from /api/me/activity's
//     `days`, which the server derives from the user's own chat
//     messages), the current consecutive-day streak, and one dot per
//     day for the week strip. A day counts if its UTC date string is
//     in the list; the streak counts back from today, or from
//     yesterday when today has no activity yet (a streak is not broken
//     by a day that is still in progress).
//   roomLastActive(room) — lastActiveAt, falling back to createdAt
//     for pre-v0.9.0 rooms (see models/Room.js), or null when neither
//     exists. One place for the fallback so the quiet split and the
//     serializer cannot drift apart.
//   quietRooms(rooms, now, quietAfterDays) — the "Recently quiet"
//     row: empty rooms (nobody in them right now) whose last activity
//     is older than the window (7 days). Live rooms are never quiet,
//     and a room active within the window stays in the main list even
//     when empty — quiet means forgotten, not just empty.

const DAY_MS = 24 * 60 * 60 * 1000;
const QUIET_AFTER_DAYS = 7;

const utcDayString = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// The last 7 UTC calendar days ending today, oldest first.
const last7Days = (now = new Date()) => {
  const end = now instanceof Date ? now : new Date(now);
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    days.push(utcDayString(new Date(end.getTime() - i * DAY_MS)));
  }
  return days;
};

export function weekActivity(dayStrings, now = new Date()) {
  const active = new Set(dayStrings || []);
  const days = last7Days(now).map((date) => ({ date, active: active.has(date) }));
  const count = days.filter((d) => d.active).length;
  // Streak: count back from today; if today is not active yet, start
  // from yesterday — the day is still in progress, not a break.
  let streak = 0;
  let i = days.length - 1;
  if (i >= 0 && !days[i].active) i -= 1;
  while (i >= 0 && days[i].active) {
    streak += 1;
    i -= 1;
  }
  return { days, count, streak };
}

export function roomLastActive(room) {
  if (!room) return null;
  const raw = room.lastActiveAt || room.createdAt;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function quietRooms(rooms, now = new Date(), quietAfterDays = QUIET_AFTER_DAYS) {
  const cutoff = (now instanceof Date ? now : new Date(now)).getTime() - quietAfterDays * DAY_MS;
  return (rooms || []).filter((room) => {
    if ((room.occupantCount || 0) > 0) return false;
    const last = roomLastActive(room);
    // No timestamp at all: we cannot prove it quiet, so it stays in
    // the main list rather than being hidden in the quiet row.
    if (!last) return false;
    return last.getTime() < cutoff;
  });
}
