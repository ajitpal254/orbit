import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Styles are split into per-area files under ./css (v0.7.0 refactor of
// the old monolithic index.css). Import order matters: it preserves the
// original cascade exactly, so keep these in this order.
import './css/base.css';
import './css/shell.css';
import './css/components.css';
import './css/auth.css';
import './css/home.css';
import './css/room.css';
import './css/voice.css';
import './css/nav.css';
import './css/friends.css';
import './css/members.css';
import './css/chat.css';
import './css/splash.css';
import './css/motion.css';
import './css/profile.css';
import './css/desktop.css';
// Self-hosted fonts (no Google Fonts CDN — the PWA must stay
// offline-friendly). Space Grotesk = display/headings/wordmark,
// Inter = body. Only the weights the app uses, latin subset only
// (the app is English/Hinglish — Latin script), so the precache stays
// small; woff2 files are precached via vite.config.js globPatterns.
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-700.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import { initPWA } from './pwa';

// Register the service worker (manual — vite.config injectRegister is
// false so the app controls the update flow; see pwa.js). Runs once
// at boot; safe to call before React mounts.
initPWA();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Fade out the static pre-JS splash screen (index.html #splash) once
// React has mounted. Idempotent and StrictMode-safe: the node is only
// touched while it still exists, and a second call is a no-op because
// the node is removed after the fade. Double rAF waits until the browser
// has painted the first React frame, so there is no blank flash between
// the static splash and the app.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('splash');
    if (!splash || splash.dataset.hiding) return;
    splash.dataset.hiding = '1';
    splash.classList.add('splash-hide');
    window.setTimeout(() => splash.remove(), 500);
  });
});
