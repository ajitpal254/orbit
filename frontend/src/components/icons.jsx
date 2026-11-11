// The app's one icon set — hand-rolled inline SVGs (24×24, stroke,
// currentColor) from iconPaths.js. No icon package is used, so the set
// stays offline-friendly and adds ~nothing to the bundle.
//
// Usage: <Icon name="mic" size={20} /> — size defaults to 20px.
// An unknown name renders nothing (and the visual-system test fails
// first — see tests/visualSystem.test.mjs).
import React from 'react';
import { ICON_PATHS } from '../iconPaths';
import { signalLevel } from '../signalLevel';

function renderEl(el, i) {
  switch (el.el) {
    case 'path':
      return <path key={i} d={el.d} />;
    case 'circle':
      return <circle key={i} cx={el.cx} cy={el.cy} r={el.r} />;
    case 'ellipse':
      return <ellipse key={i} cx={el.cx} cy={el.cy} rx={el.rx} ry={el.ry} transform={el.transform} />;
    case 'rect':
      return <rect key={i} x={el.x} y={el.y} width={el.width} height={el.height} rx={el.rx} />;
    case 'line':
      return <line key={i} x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} />;
    case 'polyline':
      return <polyline key={i} points={el.points} />;
    case 'polygon':
      return <polygon key={i} points={el.points} />;
    default:
      return null;
  }
}

export function Icon({ name, size = 20, className = '', title }) {
  const paths = ICON_PATHS[name];
  if (!paths) return null;
  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {paths.map(renderEl)}
    </svg>
  );
}

// Signal bars on an orb: the per-peer voice state at a glance instead
// of the old raw "connected / checking (host+srflx)" debug line — the
// full text now lives behind the "Connection details" popover
// (RoomView). Bars lit = signalLevel(state).bars, color = .tone-*.
export function SignalBars({ state, className = '' }) {
  const { bars, tone } = signalLevel(state);
  return (
    <span
      className={`signal-bars tone-${tone} ${className}`.trim()}
      title={`Voice: ${state || 'connecting…'}`}
      aria-label={`Voice connection: ${state || 'connecting'}`}
    >
      {[0, 1, 2, 3].map((i) => (
        <i key={i} className={i < bars ? 'lit' : ''} />
      ))}
    </span>
  );
}
