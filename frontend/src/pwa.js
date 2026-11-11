// Manual service-worker registration (vite.config.js sets
// injectRegister: false, so the plugin does NOT inject its own
// registration script). The app registers here so it can decide what
// happens when a new version is waiting.
//
// registerType is 'prompt': a new service worker installs and WAITS.
// Nothing reloads on its own — an auto-reload mid-call would drop a
// live voice call. onNeedRefresh fires when the new SW is waiting;
// the app shows an update toast, and only the user's tap on Update
// calls applyUpdate(), which tells the waiting SW to take over — the
// plugin then reloads the page to the new bundle.
//
// Guarded against double registration (React StrictMode / HMR re-runs
// this module) and against onNeedRefresh firing before the app has
// subscribed (the flag is kept, and late subscribers are told at once).
import { registerSW } from 'virtual:pwa-register';

let updateSW = null;
let updateWaiting = false;
const listeners = new Set();

export function initPWA() {
  if (updateSW) return;
  updateSW = registerSW({
    onNeedRefresh() {
      updateWaiting = true;
      listeners.forEach((fn) => fn());
    },
    onRegisterError(err) {
      console.error('Service worker registration failed', err);
    }
  });
}

export function isUpdateWaiting() {
  return updateWaiting;
}

export function onUpdateAvailable(fn) {
  listeners.add(fn);
  if (updateWaiting) fn();
  return () => listeners.delete(fn);
}

export function applyUpdate() {
  if (updateSW) updateSW(true);
}
