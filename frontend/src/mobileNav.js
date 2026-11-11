// Bottom tab bar (phones, ≤520px): the four sections and the badge
// text shared by the tab bar and the Home header bell. Pure — tested
// in tests/mobile.test.mjs. The `view` values match App.jsx's view
// state; 'profile' is the "You" tab. Icons come from the existing
// hand-rolled set (components/icons.jsx).
export const MOBILE_TABS = [
  { view: 'rooms', label: 'Rooms', icon: 'home' },
  { view: 'friends', label: 'Friends', icon: 'users' },
  { view: 'messages', label: 'Messages', icon: 'chat', badge: 'dm' },
  { view: 'profile', label: 'You', icon: 'user' }
];

// Badge counts cap at 9+ (same as the desktop rail bell and the
// topbar bell badge). Returns '' when there is nothing to show, so
// callers can render the badge conditionally on a truthy value.
export function formatBadgeCount(n) {
  const count = Number(n) || 0;
  if (count <= 0) return '';
  return count > 9 ? '9+' : String(count);
}
