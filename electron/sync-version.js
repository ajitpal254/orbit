// Keep the root package.json version in sync with frontend/package.json,
// the single source of truth for the app version (electron-builder reads
// the root version for the installer name; the release workflow tags from
// the frontend version). Run by `npm run desktop:dist` before building,
// and safe to run any time: it only writes when the versions differ.
//
// Pure logic lives in syncVersion() so it is unit-testable without
// touching disk (see tests/electron.test.js).
const fs = require('node:fs');
const path = require('node:path');

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// Returns { changed, pkg } — the root package object with its version
// replaced by the frontend version. Throws on a bad frontend version.
function syncVersion(frontendVersion, rootPkg) {
  if (typeof frontendVersion !== 'string' || !SEMVER_RE.test(frontendVersion)) {
    throw new Error(`Invalid frontend version: ${String(frontendVersion)}`);
  }
  if (rootPkg.version === frontendVersion) return { changed: false, pkg: rootPkg };
  return { changed: true, pkg: { ...rootPkg, version: frontendVersion } };
}

function main() {
  const rootDir = path.join(__dirname, '..');
  const frontendPkgPath = path.join(rootDir, 'frontend', 'package.json');
  const rootPkgPath = path.join(rootDir, 'package.json');
  const frontendVersion = JSON.parse(fs.readFileSync(frontendPkgPath, 'utf8')).version;
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  const { changed, pkg } = syncVersion(frontendVersion, rootPkg);
  if (changed) {
    fs.writeFileSync(rootPkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`desktop: root package.json version ${rootPkg.version} → ${frontendVersion}`);
  } else {
    console.log(`desktop: root package.json version already ${frontendVersion}`);
  }
}

if (require.main === module) main();

module.exports = { syncVersion };
