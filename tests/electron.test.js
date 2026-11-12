// Tests for the Windows desktop shell (electron/app-config.js +
// electron/sync-version.js). Pure logic only — no Electron/Chromium
// needed, so these run in CI like every other test.
//
// What is under test:
// - the permission allowlist: only 'media' (mic/camera) and only for
//   the hosted Orbit origin; everything else denied;
// - the single-window config (size, light-footprint settings);
// - the version plumbing: frontend/package.json is the single source
//   of truth, the root version is synced from it, and the two must
//   agree in the committed tree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  APP_URL,
  APP_ORIGIN,
  isOrbitOrigin,
  shouldAllowPermission,
  buildWindowConfig,
  getAppVersion,
} = require('../electron/app-config');
const { syncVersion } = require('../electron/sync-version');

const ORBIT = 'https://orbit-3lzs.onrender.com';
const ORBIT_ROOM = 'https://orbit-3lzs.onrender.com/#room-abc123';

test('APP_URL is the hosted Orbit site', () => {
  assert.equal(APP_URL, `${ORBIT}/`);
  assert.equal(APP_ORIGIN, ORBIT);
});

test('isOrbitOrigin accepts the hosted site (URL or origin)', () => {
  assert.equal(isOrbitOrigin(ORBIT), true);
  assert.equal(isOrbitOrigin(`${ORBIT}/`), true);
  assert.equal(isOrbitOrigin(ORBIT_ROOM), true);
});

test('isOrbitOrigin rejects lookalikes and non-https', () => {
  assert.equal(isOrbitOrigin('http://orbit-3lzs.onrender.com/'), false);
  assert.equal(isOrbitOrigin('https://orbit-3lzs.onrender.com.evil.com/'), false);
  assert.equal(isOrbitOrigin('https://evil.com/'), false);
  assert.equal(isOrbitOrigin('https://orbit-3lzs.onrender.com:8443/'), false);
  assert.equal(isOrbitOrigin(''), false);
  assert.equal(isOrbitOrigin(null), false);
  assert.equal(isOrbitOrigin('not a url'), false);
});

test('shouldAllowPermission allows media only for the Orbit origin', () => {
  assert.equal(shouldAllowPermission(ORBIT, 'media'), true);
  assert.equal(shouldAllowPermission(ORBIT_ROOM, 'media'), true);
  assert.equal(shouldAllowPermission(ORBIT, 'geolocation'), false);
  assert.equal(shouldAllowPermission(ORBIT, 'notifications'), false);
  assert.equal(shouldAllowPermission(ORBIT, 'microphone'), false);
  assert.equal(shouldAllowPermission(ORBIT, 'camera'), false);
  assert.equal(shouldAllowPermission('https://evil.com/', 'media'), false);
  assert.equal(shouldAllowPermission('http://orbit-3lzs.onrender.com/', 'media'), false);
});

test('buildWindowConfig: single window, sensible size, light settings', () => {
  const cfg = buildWindowConfig();
  assert.equal(cfg.width, 1280);
  assert.equal(cfg.height, 800);
  assert.equal(cfg.minWidth, 800);
  assert.equal(cfg.minHeight, 600);
  assert.equal(cfg.title, 'Orbit');
  assert.equal(cfg.autoHideMenuBar, true);
  assert.equal(cfg.show, false);
  assert.equal(cfg.webPreferences.contextIsolation, true);
  assert.equal(cfg.webPreferences.nodeIntegration, false);
  assert.equal(cfg.webPreferences.backgroundThrottling, true);
  // DevTools off by default (packaged builds never expose them).
  assert.equal(cfg.webPreferences.devTools, false);
  assert.equal(buildWindowConfig({ devTools: true }).webPreferences.devTools, true);
});

test('getAppVersion reads a valid frontend package.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-electron-'));
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'orbit-frontend', version: '0.7.0' }));
  assert.equal(getAppVersion(file), '0.7.0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getAppVersion throws on a bad or missing version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-electron-'));
  const bad = path.join(dir, 'package.json');
  fs.writeFileSync(bad, JSON.stringify({ name: 'orbit-frontend', version: 'v0.7' }));
  assert.throws(() => getAppVersion(bad), /Invalid app version/);
  assert.throws(() => getAppVersion(path.join(dir, 'missing.json')), /ENOENT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('syncVersion replaces the root version only when it differs', () => {
  const root = { name: 'orbit', version: '1.0.0' };
  const { changed, pkg } = syncVersion('0.7.0', root);
  assert.equal(changed, true);
  assert.equal(pkg.version, '0.7.0');
  assert.equal(root.version, '1.0.0'); // input untouched
  assert.deepEqual(syncVersion('0.7.0', pkg), { changed: false, pkg });
});

test('syncVersion throws on a non-semver frontend version', () => {
  assert.throws(() => syncVersion('v0.7', { version: '1.0.0' }), /Invalid frontend version/);
  assert.throws(() => syncVersion(undefined, { version: '1.0.0' }), /Invalid frontend version/);
});

test('committed root version matches the frontend version', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const frontendPkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'frontend', 'package.json'), 'utf8')
  );
  assert.equal(
    rootPkg.version,
    frontendPkg.version,
    'root package.json version must be synced from frontend/package.json (run npm run desktop:sync-version)'
  );
});
