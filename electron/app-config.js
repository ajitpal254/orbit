// Pure, testable configuration for the Orbit Windows shell.
//
// This module has NO Electron imports so it can be unit-tested with plain
// node (see tests/electron.test.js). The main process (electron/main.js)
// is the only file that touches Electron APIs.
//
// The shell is a thin wrapper: it loads the HOSTED Orbit site. It bundles
// no server and no database — voice, rooms and chat all live on the
// hosted app. Offline / bundled-server use is out of scope.

const APP_URL = 'https://orbit-3lzs.onrender.com/';
const APP_ORIGIN = 'https://orbit-3lzs.onrender.com';

// Single BrowserWindow only. No hidden windows, no tray, no background
// services, no auto-updater — the light-footprint rule for this app.
const WINDOW_DEFAULTS = {
  width: 1280,
  height: 800,
  minWidth: 800,
  minHeight: 600,
  title: 'Orbit',
};

// Is this URL (or origin) the hosted Orbit site?
function isOrbitOrigin(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

// Permission gate for the shell. Voice calls need microphone + camera,
// which Electron reports as the single 'media' permission for
// getUserMedia. Only that permission, and only for the hosted Orbit
// origin, is allowed. Everything else (geolocation, notifications,
// MIDI, fullscreen, ...) is denied by default — the renderer gets no
// other capabilities. `requestingUrl` may be a full URL or an origin.
function shouldAllowPermission(requestingUrl, permission) {
  if (permission !== 'media') return false;
  return isOrbitOrigin(requestingUrl);
}

// Full BrowserWindow options for the single window. `devTools` is on
// only when the app runs unpackaged (local dev); packaged builds never
// expose DevTools.
function buildWindowConfig({ devTools = false } = {}) {
  return {
    ...WINDOW_DEFAULTS,
    autoHideMenuBar: true,
    show: false, // shown on ready-to-show, so there is no white flash
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true, // keep the light rule: throttle when hidden
      devTools,
    },
  };
}

// Google sign-in rejects Electron's default user agent: it carries an
// "Electron/x.y.z" token, and Google treats the shell as an embedded
// browser — the account chooser loads, then the sign-in step fails with
// a 400 ("The server cannot process the request because it is
// malformed"). Strip the Electron token so the shell presents as plain
// Chrome. Pure function: returns the input unchanged when there is no
// Electron token (or the input is not a usable string).
function chromeUserAgent(defaultUa) {
  if (typeof defaultUa !== 'string' || !defaultUa) return defaultUa;
  return defaultUa.replace(/ ?Electron\/[^\s]+/g, '');
}

// Read the app version from frontend/package.json — the single source
// of truth for the version (the release workflow tags from it too).
// Throws on a missing file or a non-semver version.
function getAppVersion(frontendPackageJsonPath) {
  const fs = require('node:fs');
  const raw = fs.readFileSync(frontendPackageJsonPath, 'utf8');
  const pkg = JSON.parse(raw);
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error(`Invalid app version in ${frontendPackageJsonPath}: ${String(pkg.version)}`);
  }
  return pkg.version;
}

module.exports = {
  APP_URL,
  APP_ORIGIN,
  WINDOW_DEFAULTS,
  isOrbitOrigin,
  shouldAllowPermission,
  buildWindowConfig,
  chromeUserAgent,
  getAppVersion,
};
