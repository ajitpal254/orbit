// Desktop right panel for Home: who's online and where, plus a short
// activity feed. Both halves reuse data that already exists — friend
// presence from GET /api/friends/presence (socket registries, see
// lib/friendPresence.js) and activity from GET /api/notifications, the
// same endpoint the Notifications center uses. Never fake entries: an
// empty list shows a quiet empty state. Hidden below 900px (index.css);
// Home only mounts it on the rooms view.
import React, { useEffect, useState, useCallback } from 'react';
import { apiJson, getFriendsPresence, getNotifications } from '../api';
import Avatar from './Avatar';
import { Icon } from './icons';
import { groupActivity } from '../desktop';

const ICONS = {
  friend_request: 'user-plus',
  friend_accepted: 'check-circle',
  room_invite: 'lock',
  dm: 'chat'
};

// Mirrors the timeAgo in Notifications.jsx (kept local so this panel
// does not reach into another view's internals).
const timeAgo = (iso) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d}d ago`;
};

export default function SidePanel({ refreshTick, onJoinRoom, onNavigate, friends: friendsProp }) {
  // Home fetches GET /api/friends/presence once and passes it here
  // (shared with the night sky) — when `friends` is provided, use it
  // and skip this panel's own fetch/poll entirely. `undefined` means
  // "not provided" (standalone use): fall back to fetching here, so
  // the panel still works on its own. `null` while provided means
  // "still loading".
  const [ownFriends, setOwnFriends] = useState(null);
  const friends = friendsProp !== undefined ? friendsProp : ownFriends;
  const [activity, setActivity] = useState([]);
  const [error, setError] = useState('');
  const [joining, setJoining] = useState(null);

  const loadPresence = useCallback(async () => {
    if (friendsProp !== undefined) return;
    try {
      setOwnFriends(await getFriendsPresence());
    } catch {}
  }, [friendsProp]);

  const loadActivity = useCallback(async () => {
    try {
      const data = await getNotifications(8, 0);
      setActivity(data.notifications || []);
    } catch {}
  }, []);

  useEffect(() => {
    loadPresence();
    loadActivity();
    // Only poll here when this panel owns the fetch (no `friends`
    // prop); Home polls on the shared path otherwise.
    if (friendsProp !== undefined) return undefined;
    const t = setInterval(loadPresence, 5000); // same cadence as Home's room poll
    return () => clearInterval(t);
  }, [loadPresence, loadActivity, friendsProp]);

  // Socket pushes (friend request / invite / DM) bump refreshTick in App.
  useEffect(() => {
    if (refreshTick > 0) {
      loadPresence();
      loadActivity();
    }
  }, [refreshTick, loadPresence, loadActivity]);

  const joinFriendRoom = async (friend) => {
    if (!friend.room) return;
    setError('');
    setJoining(friend.id);
    try {
      const room = await apiJson(`/api/rooms/${friend.room.id}`);
      onJoinRoom(room);
    } catch (err) {
      setError(err.message);
    } finally {
      setJoining(null);
    }
  };

  const openActivity = (n) => {
    if (!onNavigate) return;
    if (n.type === 'room_invite' && n.room) {
      onNavigate({ view: 'rooms', roomId: n.room.id });
    } else if (n.type === 'dm' && n.actor) {
      onNavigate({ view: 'messages', dmUser: n.actor });
    } else {
      onNavigate({ view: 'friends' });
    }
  };

  const onlineCount = (friends || []).filter((f) => f.status !== 'away').length;
  // Consecutive rows from the same actor collapse into one row with a
  // count ("3 new messages from Ajit Pal"); a click navigates using
  // the newest underlying notification.
  const groupedActivity = groupActivity(activity);

  return (
    <aside className="home-side" aria-label="Friends and activity">
      <section className="side-section">
        <h3 className="section-title">
          <span className="count-dot" /> Friends
          {friends !== null && onlineCount > 0 && ` · ${onlineCount} online`}
        </h3>
        {friends === null && <p className="muted">Finding friends…</p>}
        {friends !== null && friends.length === 0 && (
          <p className="muted side-empty">No friends yet — add friends from the Friends tab to see who's online.</p>
        )}
        {friends !== null && friends.length > 0 && (
          <div className="people-list">
            {friends.map((f, i) => (
              <div key={f.id} className="person-row stagger-in" style={{ animationDelay: `${i * 40}ms` }}>
                <Avatar user={f} size="sm" className="person-orb" />
                <span className="person-info">
                  <strong>{f.name || 'Unnamed'}</strong>
                  <span className="muted person-email">
                    {f.status === 'in-room' && f.room
                      ? `In ${f.room.name}`
                      : f.status === 'online'
                        ? 'Online'
                        : 'Away'}
                  </span>
                </span>
                <span className="row-actions">
                  <span
                    className={`presence-dot presence-${f.status}`}
                    title={f.status === 'in-room' ? `In ${f.room?.name || 'a room'}` : f.status}
                    aria-label={f.status}
                  />
                  {f.status === 'in-room' && f.room && (
                    <button
                      className="btn btn-primary btn-small"
                      disabled={joining === f.id}
                      onClick={() => joinFriendRoom(f)}
                    >
                      {joining === f.id ? 'Joining…' : 'Join'}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="side-section">
        <h3 className="section-title">Activity</h3>
        {activity.length === 0 ? (
          <p className="muted side-empty">Nothing yet — friend requests, room invites and DMs will show up here.</p>
        ) : (
          <div className="notif-list">
            {groupedActivity.map((g, i) => (
              <button
                key={g.newest.id}
                className={`notif-row stagger-in ${g.unread ? 'unread' : ''}`}
                style={{ animationDelay: `${i * 40}ms` }}
                onClick={() => openActivity(g.newest)}
              >
                <span className="notif-icon"><Icon name={ICONS[g.type] || 'bell'} size={20} /></span>
                <Avatar user={g.actor || {}} size="sm" />
                <span className="person-info">
                  <span className="notif-text">{g.text}</span>
                  <span className="muted notif-time">{timeAgo(g.latestAt)}</span>
                </span>
                {g.unread && <span className="notif-dot" aria-label="Unread" />}
              </button>
            ))}
          </div>
        )}
        {/* Desktop polish (Plan v2 §2 fix ③): a dim line under the last
            activity item when the night is quiet — empty list or a
            single item — so the panel doesn't end abruptly. */}
        {groupedActivity.length < 2 && (
          <p className="muted side-quiet">Quiet tonight</p>
        )}
      </section>
    </aside>
  );
}
