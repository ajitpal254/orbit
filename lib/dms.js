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

const s = (v) => String(v);

// DMs are friends-only: only an accepted friendship opens a thread.
const canDm = (friendRows = [], me, other) => areFriends(friendRows, me, other);

// Unread messages from `other` to `me` in a list of dm rows.
const unreadFor = (messages = [], me, other) => {
  const x = s(me);
  const y = s(other);
  return messages.filter((m) =>
    s(m.sender) === y && s(m.recipient) === x && !m.read
  ).length;
};

// The latest message between me and other, or null. `fromMe` tells the
// list view whether to prefix the preview with "You: ".
const lastMessageFor = (messages = [], me, other) => {
  const x = s(me);
  const y = s(other);
  let latest = null;
  for (const m of messages) {
    const a = s(m.sender);
    const b = s(m.recipient);
    if (!((a === x && b === y) || (a === y && b === x))) continue;
    if (!latest || new Date(m.createdAt) > new Date(latest.createdAt)) latest = m;
  }
  if (!latest) return null;
  return {
    text: latest.text,
    createdAt: latest.createdAt,
    fromMe: s(latest.sender) === x
  };
};

// One list entry per friend, sorted by last-message recency (newest
// first); friends with no messages go last, ordered by name.
const buildSummaries = (friends = [], messages = [], me) => {
  const summaries = friends.map((f) => ({
    userId: s(f.id),
    name: f.name || '',
    email: f.email || '',
    lastMessage: lastMessageFor(messages, me, f.id),
    unreadCount: unreadFor(messages, me, f.id)
  }));
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

module.exports = { canDm, unreadFor, lastMessageFor, buildSummaries };
