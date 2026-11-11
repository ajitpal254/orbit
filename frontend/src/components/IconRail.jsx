// Desktop icon rail: the slim left navigation for the 3-zone layout.
// Replaces the centred top tabs at ≥900px (see index.css — the rail is
// display:none below that, and .view-tabs is hidden there instead).
// Icons are the hand-rolled SVG set (components/icons.jsx): the planet
// wordmark up top, then home / users / chat / bell for the sections.
// Hidden while inside a room, exactly like the tab bar it replaces.
import React from 'react';
import Avatar from './Avatar';
import { Icon } from './icons';

const ITEMS = [
  { view: 'rooms', label: 'Rooms', icon: 'home' },
  { view: 'friends', label: 'Friends', icon: 'users' },
  { view: 'messages', label: 'Messages', icon: 'chat', badge: 'dm' },
  { view: 'notifications', label: 'Notifications', icon: 'bell', badge: 'notif' }
];

export default function IconRail({ user, view, dmUnread, notifUnread, onNavigate }) {
  const badges = { dm: dmUnread || 0, notif: notifUnread || 0 };
  return (
    <nav className="icon-rail" aria-label="Sections">
      <span className="rail-logo" aria-hidden="true"><Icon name="planet" size={24} /></span>
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
              <span className="rail-ico" aria-hidden="true"><Icon name={item.icon} size={22} /></span>
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
