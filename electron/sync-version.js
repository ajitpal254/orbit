// Keep the root package.json AND electron/package.json versions in sync
// with frontend/package.json, the single source of truth for the app
// version (electron-builder reads the electron package version for the
// installer name; the release workflow tags from the frontend version).
// Run by `npm run desktop:dist` before building, and safe to run any
// time: it only writes when the versions differ.
//
// The packaging toolchain (Electron + electron-builder) lives in its own
// electron/package.json on purpose: the root install stays clean — no
// deprecated warnings from the packaging toolchain and no ~100 MB
// Electron binary download on Render deploys. Only the release workflow
// installs the electron/ package.
//
// Pure logic lives in syncVersion() so it is unit-testable without
// touching disk (see tests/electron.test.js).
const fs = require('node:fs');
const path = require('node:path');

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// Returns { changed, pkg } — the package object with its version
// replaced by the frontend version. Throws on a bad frontend version.
function syncVersion(frontendVersion, pkg) {
  if (typeof frontendVersion !== 'string' || !SEMVER_RE.test(frontendVersion)) {
    throw new Error(`Invalid frontend version: ${String(frontendVersion)}`);
  }
  if (pkg.version === frontendVersion) return { changed: false, pkg };
  return { changed: true, pkg: { ...pkg, version: frontendVersion } };
}

// Sync one package.json file from the frontend version; returns true
// when the file was rewritten.
function syncFile(pkgPath, frontendVersion) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const { changed, pkg: synced } = syncVersion(frontendVersion, pkg);
  if (changed) {
    fs.writeFileSync(pkgPath, `${JSON.stringify(synced, null, 2)}\n`);
    console.log(`desktop: ${pkgPath} version ${pkg.version} → ${frontendVersion}`);
  } else {
    console.log(`desktop: ${pkgPath} version already ${frontendVersion}`);
  }
  return changed;
}

function main() {
  const rootDir = path.join(__dirname, '..');
  const frontendPkgPath = path.join(rootDir, 'frontend', 'package.json');
  const frontendVersion = JSON.parse(fs.readFileSync(frontendPkgPath, 'utf8')).version;
  syncFile(path.join(rootDir, 'package.json'), frontendVersion);
  syncFile(path.join(__dirname, 'package.json'), frontendVersion);
}

if (require.main === module) main();

module.exports = { syncVersion, syncFile };
