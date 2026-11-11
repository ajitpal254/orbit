// Notifications center: the persistent list behind the bell. Rows are
// newest first; tapping one marks it read and jumps to the right place
// (Friends tab, the invited room, or the DM thread). The list refreshes
// live — App bumps refreshTick on every friend-request / room-invite /
// friend-accepted / dm-message socket push.
import React, { useEffect, useState, useCallback } from 'react';
import { getNotifications, markNotificationRead, markAllNotificationsRead } from '../api';
import Avatar from './Avatar';

const ICONS = {
  friend_request: '👋',
  friend_accepted: '✅',
  room_invite: '🔒',
  dm: '💬'
};

const timeAgo = (iso) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d}d ago`;
};

export default function Notifications({ refreshTick, onNavigate, onBack, onRead }) {
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await getNotifications(30, 0);
      setItems(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshTick]);

  const open = async (n) => {
    // Mark read optimistically; a failure here must not block the jump.
    if (!n.read) {
      setItems((prev) => prev.map((i) => (i.id === n.id ? { ...i, read: true } : i)));
      setUnreadCount((c) => Math.max(0, c - 1));
      markNotificationRead(n.id).catch(() => {});
      if (onRead) onRead();
    }
    if (n.type === 'room_invite' && n.room) {
      onNavigate({ view: 'rooms', roomId: n.room.id });
    } else if (n.type === 'dm' && n.actor) {
      onNavigate({ view: 'messages', dmUser: n.actor });
    } else {
      onNavigate({ view: 'friends' });
    }
  };

  const readAll = async () => {
    try {
      await markAllNotificationsRead();
      setItems((prev) => prev.map((i) => ({ ...i, read: true })));
      setUnreadCount(0);
      if (onRead) onRead();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="view view-anim">
      <button className="btn btn-text back-btn" onClick={onBack}>← Back</button>
      <div className="greeting">
        <p className="date-line">Stay in the loop</p>
        <h2>Notifications 🔔</h2>
        <p className="muted">
          {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up.'}
        </p>
      </div>

      {unreadCount > 0 && (
        <button className="btn btn-text" onClick={readAll}>Mark all as read</button>
      )}
      {error && <p className="error">{error}</p>}
      {loading && <p className="muted">Loading notifications…</p>}

      {!loading && items.length === 0 && (
        <div className="card empty-state">
          <span className="big-emoji">🔔</span>
          <p className="muted">Nothing here yet — friend requests, room invites and DMs will show up here.</p>
        </div>
      )}

      <div className="notif-list">
        {items.map((n, i) => (
          <button
            key={n.id}
            className={`notif-row stagger-in ${n.read ? '' : 'unread'}`}
            style={{ animationDelay: `${i * 40}ms` }}
            onClick={() => open(n)}
          >
            <span className="notif-icon">{ICONS[n.type] || '🔔'}</span>
            <Avatar user={n.actor || {}} size="sm" />
            <span className="person-info">
              <span className="notif-text">{n.text}</span>
              <span className="muted notif-time">{timeAgo(n.updatedAt || n.createdAt)}</span>
            </span>
            {!n.read && <span className="notif-dot" aria-label="Unread" />}
          </button>
        ))}
      </div>
    </div>
  );
}
