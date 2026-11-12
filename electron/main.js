// Orbit Windows shell — Electron main process.
//
// A thin wrapper around the HOSTED Orbit site (https://orbit-3lzs.onrender.com/).
// It bundles no server and no database: rooms, voice and chat all live on
// the hosted app. The shell is one window, nothing else — no tray, no
// background services, no auto-updater, no second window. That is the
// light-footprint rule for this app; keep it that way.
//
// Security posture: the renderer is a plain web page — contextIsolation
// on, nodeIntegration off, no preload script (nothing is exposed to the
// page), and media devices are granted only to the hosted Orbit origin
// (see electron/app-config.js shouldAllowPermission).
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const { APP_URL, shouldAllowPermission, buildWindowConfig, chromeUserAgent } = require('./app-config');

// Modest renderer JS heap cap. Voice + a single room view do not need
// more; the cap keeps a runaway page from eating the machine.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');

let mainWindow = null;
let loadRetries = 0;
const MAX_LOAD_RETRIES = 3;
const LOAD_RETRY_MS = 3000;

function createWindow() {
  const win = new BrowserWindow({
    ...buildWindowConfig({ devTools: !app.isPackaged }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });

  // Media devices: allow mic/camera for the hosted Orbit origin only.
  // Both the request handler and the check handler go through the same
  // allowlist so a page cannot probe permissions another way.
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(shouldAllowPermission(webContents.getURL(), permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return shouldAllowPermission(requestingOrigin, permission);
  });

  // Google sign-in rejects Electron's default user agent (see
  // chromeUserAgent in app-config.js): the account chooser loads, then
  // the sign-in step 400s. Send a plain Chrome user agent instead —
  // on the session (covers the Google popup windows too) and on this
  // window. The shell only ever loads the hosted Orbit site, so a
  // Chrome user agent everywhere is the honest one here.
  const chromeUa = chromeUserAgent(ses.getUserAgent());
  ses.setUserAgent(chromeUa);
  win.webContents.setUserAgent(chromeUa);

  win.once('ready-to-show', () => win.show());

  // The hosted site hibernates on Render's free tier; the web app's own
  // splash covers a slow wake. But a failed navigation leaves a blank
  // window — retry the main frame a few times, then leave the error
  // page up instead of spinning forever. ERR_ABORTED (-3) means the
  // navigation was superseded (e.g. a redirect) and must not retry.
  win.webContents.on('did-fail-load', (_event, errorCode, _desc, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    if (loadRetries >= MAX_LOAD_RETRIES) return;
    loadRetries += 1;
    setTimeout(() => {
      if (!win.isDestroyed()) win.loadURL(APP_URL);
    }, LOAD_RETRY_MS);
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  win.loadURL(APP_URL);
  return win;
}

// Single instance: a second launch focuses the existing window instead
// of opening another one (one window, always). Checked before the app
// is ready so two launches cannot race past each other.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.orbit.app');
    mainWindow = createWindow();
  });

  // No background process: when the only window closes, the app quits.
  // (Windows-only app, so there is no macOS dock behaviour to preserve.)
  app.on('window-all-closed', () => {
    app.quit();
  });
}
