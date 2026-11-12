// Time-of-day backgrounds (playbook p.11, visual system): the
// ambient layer changes slowly with the viewer's local time, so the
// app feels like a place. Pure + testable — no DOM, no React.
//
//   Night · 9pm–5am  · deep violet
//   Dawn  · 5am–10am · rose and gold
//   Day   · 10am–5pm · cool teal
//   Dusk  · 5pm–9pm  · magenta and ember
//
// Deterministic from local time (Date#getHours): two people in the
// same timezone see the same sky, and the palette only changes at
// the four boundaries. The client re-checks every few minutes (see
// App.jsx), so a boundary crossing lands within minutes, not on the
// next reload. Only colours change — no new animation — so
// prefers-reduced-motion needs nothing extra here.
export const DAYPARTS = ['dawn', 'day', 'dusk', 'night'];

export const DAYPART_META = {
  dawn: { label: 'Dawn', hours: '5am–10am', note: 'rose and gold' },
  day: { label: 'Day', hours: '10am–5pm', note: 'cool teal' },
  dusk: { label: 'Dusk', hours: '5pm–9pm', note: 'magenta and ember' },
  night: { label: 'Night', hours: '9pm–5am', note: 'deep violet' }
};

// Boundaries are [start, end) in local hours; night wraps midnight.
export function daypartFor(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5 && h < 10) return 'dawn';
  if (h >= 10 && h < 17) return 'day';
  if (h >= 17 && h < 21) return 'dusk';
  return 'night';
}

export const isValidDaypart = (d) => DAYPARTS.includes(d);

export const daypartLabel = (d) => (DAYPART_META[d] || DAYPART_META.night).label;
