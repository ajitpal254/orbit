// Bottom tab bar (phones only — display:none above 520px in CSS).
// Replaces the top .view-tabs on phones: a floating glass pill fixed
// to the bottom with safe-area padding. Hidden inside an open room
// view (App only renders it when !inRoom) — the voice bar owns the
// bottom there. The Messages tab carries the DM unread badge; the
// notifications badge lives on the bell in the Home header.
import React from 'react';
import { Icon } from './icons';
import { MOBILE_TABS, formatBadgeCount } from '../mobileNav';

export default function MobileTabBar({ view, dmUnread, onNavigate }) {
  return (
    <nav className="mobile-tab-bar" aria-label="Sections">
      {MOBILE_TABS.map((item) => {
        const badge = item.badge === 'dm' ? formatBadgeCount(dmUnread) : '';
        const active = view === item.view;
        return (
          <button
            key={item.view}
            className={`mobile-tab${active ? ' active' : ''}`}
            onClick={() => onNavigate(item.view)}
            aria-label={`${item.label}${badge ? `, ${badge} unread` : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <span className="mobile-tab-ico" aria-hidden="true"><Icon name={item.icon} size={22} /></span>
            <span className="mobile-tab-label">{item.label}</span>
            {badge && <span className="mobile-tab-badge">{badge}</span>}
          </button>
        );
      })}
    </nav>
  );
}
