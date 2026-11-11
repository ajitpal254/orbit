import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

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
