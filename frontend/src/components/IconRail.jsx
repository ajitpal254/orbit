// Desktop icon rail: the slim left navigation for the 3-zone layout.
// Replaces the centred top tabs at ≥900px (see index.css — the rail is
// display:none below that, and .view-tabs is hidden there instead).
// Icons reuse the app's existing emoji language (🪐 / 🔔 / 💬); the
// visual-system pass replaces emoji with the SVG set later — this file
// only owns layout and structure. Hidden while inside a room, exactly
// like the tab bar it replaces.
import React from 'react';
import Avatar from './Avatar';

const ITEMS = [
  { view: 'rooms', label: 'Rooms', icon: '🪐' },
  { view: 'friends', label: 'Friends', icon: '👥' },
  { view: 'messages', label: 'Messages', icon: '💬', badge: 'dm' },
  { view: 'notifications', label: 'Notifications', icon: '🔔', badge: 'notif' }
];

export default function IconRail({ user, view, dmUnread, notifUnread, onNavigate }) {
  const badges = { dm: dmUnread || 0, notif: notifUnread || 0 };
  return (
    <nav className="icon-rail" aria-label="Sections">
      <span className="rail-logo" aria-hidden="true">🪐</span>
      <div className="rail-items">
        {ITEMS.map((item) => {
          const badge = item.badge ? badges[item.badge] : 0;
          return (
            <button
              key={item.view}
              className={`rail-btn ${view === item.view ? 'active' : ''}`}
              onClick={() => onNavigate(item.view)}
              aria-label={`${item.label}${badge > 0 ? `, ${badge} unread` : ''}`}
              aria-current={view === item.view ? 'page' : undefined}
              title={item.label}
            >
              <span className="rail-ico" aria-hidden="true">{item.icon}</span>
              <span className="rail-tip" aria-hidden="true">{item.label}</span>
              {badge > 0 && <span className="rail-badge">{badge > 9 ? '9+' : badge}</span>}
            </button>
          );
        })}
      </div>
      <button
        className={`rail-btn rail-profile ${view === 'profile' ? 'active' : ''}`}
        onClick={() => onNavigate('profile')}
        aria-label="Profile"
        title="Profile"
      >
        <Avatar user={user} size="sm" />
        <span className="rail-tip" aria-hidden="true">Profile</span>
      </button>
    </nav>
  );
}
