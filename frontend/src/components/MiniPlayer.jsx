import React, { useEffect, useState } from 'react';
import { formatCallDuration } from '../voiceSession';
import { Icon } from './icons';

// Mini-player: shown while a voice session is active but the room view
// is not on screen (App.jsx renders it only then — never together with
// the room view's own voice bar). Tap anywhere to jump back into the
// room; the mute button toggles the same session the voice bar controls,
// so both always agree.
export default function MiniPlayer({ roomName, joinedAt, muted, modMuted, reconnecting, onToggleMute, onReturn }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, now - (joinedAt || now));
  return (
    <div
      className="mini-player"
      onClick={onReturn}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onReturn();
        }
      }}
      aria-label={reconnecting ? `Back to ${roomName}, reconnecting` : `Back to ${roomName}, in call ${formatCallDuration(elapsed)}`}
    >
      <span className="mini-player-dot" aria-hidden="true" />
      <span className="mini-player-info">
        <strong>{roomName}</strong>
        {/* Reconnecting (v0.9.0): the call is still the same one —
            say so instead of a frozen timer. */}
        <span className="mini-player-time">{reconnecting ? 'Reconnecting…' : formatCallDuration(elapsed)}</span>
      </span>
      <button
        className={`voice-btn mini-player-mute ${muted ? 'off' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMute();
        }}
        disabled={modMuted}
        title={modMuted ? 'Muted by moderator' : undefined}
        aria-label={modMuted ? 'Muted by moderator' : muted ? 'Unmute' : 'Mute'}
      >
        <span key={muted ? 'off' : 'on'} className="voice-ico"><Icon name={muted ? 'mic-off' : 'mic'} size={26} /></span>
      </button>
    </div>
  );
}
