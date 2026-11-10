// Google Identity Services (one-tap sign-in) helpers.
//
// Pure at import time: nothing here touches window/document until called,
// so this module is unit-testable in Node. The Google button only ever
// appears when the server reports a client ID (GET /api/config) — with no
// GOOGLE_CLIENT_ID configured, the password form is the whole UI.
//
// Privacy: Google only sees the login event. No chat, room, or voice data
// goes to Google.

const GSI_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

// Pull the client ID out of the /api/config response. Returns the trimmed
// string, or null when Google sign-in is not configured.
export const getGoogleClientId = (config) => {
  const id = config && typeof config.googleClientId === 'string'
    ? config.googleClientId.trim()
    : '';
  return id || null;
};

// The single gate Auth.jsx uses: no client ID -> no Google button, and the
// password flow keeps working untouched.
export const shouldShowGoogleButton = (clientId) => Boolean(clientId);

let scriptPromise = null;

// Dynamically load the Google Identity Services script. Resolves once
// window.google.accounts.id is available; rejects on load error. Safe to
// call repeatedly — the script is only injected once.
export const loadGoogleScript = () => {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.google && window.google.accounts && window.google.accounts.id) {
    return Promise.resolve();
  }
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GSI_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromise = null;
        reject(new Error('Could not load Google sign-in'));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
};

// Render the official Google button into `element`. `onCredential` receives
// the ID-token credential string on a successful click. Throws if the GSI
// script has not loaded yet.
export const renderGoogleButton = (element, clientId, onCredential) => {
  if (!window.google || !window.google.accounts || !window.google.accounts.id) {
    throw new Error('Google sign-in script not loaded');
  }
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: (response) => {
      if (response && response.credential) onCredential(response.credential);
    }
  });
  const width = Math.max(200, Math.min(400, element.clientWidth || 300));
  window.google.accounts.id.renderButton(element, {
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    width
  });
};
