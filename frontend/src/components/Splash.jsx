// Splash screen shown while the app boots (the /api/auth/me check).
// Same look as the static #splash in index.html, which paints before JS
// loads. The status text stages by elapsed time so a Render free-tier
// cold start (30–60s while the server wakes) reads as progress, not a
// freeze — and after 25s a Retry button re-runs the boot check.
import React, { useEffect, useState } from 'react';

export default function Splash({ onRetry }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const status =
    elapsed < 8
      ? 'Connecting…'
      : elapsed < 25
        ? 'Waking up the server — free servers take a moment…'
        : 'Still waking up…';

  return (
    <div className="splash">
      <div className="splash-orbs" aria-hidden="true">
        <span className="splash-orb splash-orb-a" />
        <span className="splash-orb splash-orb-b" />
        <span className="splash-orb splash-orb-c" />
      </div>
      <p className="splash-wordmark">🪐 Orbit</p>
      <p className="splash-status">{status}</p>
      {elapsed >= 25 && onRetry && (
        <button className="btn btn-primary btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
