// Pure direct-message helpers. No DB access here so these are
// unit-testable without MongoDB.
//
// Rows are plain objects with string ids:
//   friendship: { requester, recipient, status: 'pending' | 'accepted' }
//   dm:         { sender, recipient, text, read, createdAt }
//   friend:     { id, name, email }
// Ids may be ObjectIds or strings — everything is compared as strings.
// `text` on a dm is expected to be already-decrypted plaintext.

const { areFriends } = require('./friends');
const { isVisible } = require('./fadingChat');

const s = (v) => String(v);

// DMs are friends-only: only an accepted friendship opens a thread.
const canDm = (friendRows = [], me, other) => areFriends(friendRows, me, other);

// Unread messages from `other` to `me` in a list of dm rows. Expired
// rows never count: fading chat hides them everywhere, including the
// unread badge. Legacy rows with no expireAt stay visible (see
// lib/fadingChat.js).
const unreadFor = (messages = [], me, other, now = new Date()) => {
  const x = s(me);
  const y = s(other);
  return messages.filter((m) =>
    isVisible(m, now) && s(m.sender) === y && s(m.recipient) === x && !m.read
  ).length;
};

// The latest message between me and other, or null. `fromMe` tells the
// list view whether to prefix the preview with "You: ". Expired rows
// are skipped, so the preview falls back to the newest visible message.
const lastMessageFor = (messages = [], me, other, now = new Date()) => {
  const x = s(me);
  const y = s(other);
  let latest = null;
  for (const m of messages) {
    if (!isVisible(m, now)) continue;
    const a = s(m.sender);
    const b = s(m.recipient);
    if (!((a === x && b === y) || (a === y && b === x))) continue;
    if (!latest || new Date(m.createdAt) > new Date(latest.createdAt)) latest = m;
  }
  if (!latest) return null;
  return {
    text: latest.text,
    createdAt: latest.createdAt,
    fromMe: s(latest.sender) === x,
    // So the list can show "📷 Photo" for a media-only last message.
    media: latest.media || null
  };
};

// One list entry per friend, sorted by last-message recency (newest
// first); friends with no messages go last, ordered by name. Avatar
// fields pass through so the list can show each friend's avatar.
const sortSummaries = (summaries) => {
  summaries.sort((a, b) => {
    const ta = a.lastMessage ? new Date(a.lastMessage.createdAt) : null;
    const tb = b.lastMessage ? new Date(b.lastMessage.createdAt) : null;
    if (ta && tb) return tb - ta;
    if (ta) return -1;
    if (tb) return 1;
    return a.name.localeCompare(b.name);
  });
  return summaries;
};

// Summaries from per-friend data (audit I8): the caller fetched only
// the latest message per friend (and counted unread per friend),
// instead of one global 1,000-row decrypt. `latestByFriend` maps
// friend id -> latest dm row (text already decrypted); `unreadByFriend`
// maps friend id -> unread count. Expired rows are skipped, so a
// stale last message degrades to null rather than surfacing.
const buildSummariesFromLatest = (friends = [], latestByFriend = new Map(), unreadByFriend = new Map(), me, now = new Date()) => {
  const summaries = friends.map((f) => {
    const raw = latestByFriend.get(s(f.id)) || null;
    const last = raw && isVisible(raw, now) ? raw : null;
    return {
      userId: s(f.id),
      name: f.name || '',
      email: f.email || '',
      avatarPreset: f.avatarPreset || null,
      avatarImage: f.avatarImage || '',
      lastMessage: last
        ? {
            text: last.text,
            createdAt: last.createdAt,
            fromMe: s(last.sender) === s(me),
            // So the list can show "📷 Photo" for a media-only last message.
            media: last.media || null
          }
        : null,
      unreadCount: unreadByFriend.get(s(f.id)) || 0
    };
  });
  return sortSummaries(summaries);
};

const buildSummaries = (friends = [], messages = [], me, now = new Date()) => {
  const summaries = friends.map((f) => ({
    userId: s(f.id),
    name: f.name || '',
    email: f.email || '',
    avatarPreset: f.avatarPreset || null,
    avatarImage: f.avatarImage || '',
    lastMessage: lastMessageFor(messages, me, f.id, now),
    unreadCount: unreadFor(messages, me, f.id, now)
  }));
  return sortSummaries(summaries);
};

module.exports = { canDm, unreadFor, lastMessageFor, buildSummaries, buildSummariesFromLatest };
