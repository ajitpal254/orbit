import React from 'react';
import { Icon } from './icons';

// Shown when a new service-worker version is waiting (see pwa.js).
// Never auto-reloads: tapping Update is the only thing that reloads,
// so a live voice call is never dropped by surprise. Dismiss hides it
// for the session; it reappears on the next launch if the new version
// is still waiting.
export default function UpdateToast({ onUpdate, onDismiss }) {
  return (
    <div className="update-toast" role="status">
      <p>
        New version available
        <small>Update when you&rsquo;re between calls — it reloads the app.</small>
      </p>
      <button className="btn btn-primary btn-small" onClick={onUpdate}>
        Update
      </button>
      <button
        className="btn btn-text btn-small"
        onClick={onDismiss}
        aria-label="Dismiss update"
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
