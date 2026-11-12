// Lazy-loaded views (v0.7.0): Profile / About / Notifications are not
// on the first screen, so they must ship as separate chunks loaded on
// demand — not in the main bundle. This is a source-level contract:
// the app shell must lazy-load them and render each behind a Suspense
// fallback, so a failed chunk load degrades to the fallback instead
// of a blank screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSrc = readFileSync(new URL('../frontend/src/App.jsx', import.meta.url), 'utf8');

const LAZY_VIEWS = ['Profile', 'About', 'Notifications'];

for (const name of LAZY_VIEWS) {
  test(`App lazy-loads ${name} instead of statically importing it`, () => {
    assert.ok(
      appSrc.includes(`const ${name} = lazy(() => import('./components/${name}'))`),
      `App should lazy-load ${name}`
    );
    assert.ok(
      !appSrc.includes(`import ${name} from './components/${name}'`),
      `App should NOT statically import ${name}`
    );
  });
}

test('App renders each lazy view behind a Suspense fallback', () => {
  for (const name of LAZY_VIEWS) {
    // Each lazy view's JSX is wrapped in <Suspense fallback=...>.
    const tag = `<${name}`;
    const idx = appSrc.indexOf(tag);
    assert.ok(idx >= 0, `App should render <${name}>`);
    const before = appSrc.slice(0, idx);
    const suspenseIdx = before.lastIndexOf('<Suspense fallback=');
    assert.ok(suspenseIdx >= 0, `App should wrap <${name}> in a <Suspense fallback>`);
    // No other lazy view's closing tag between the Suspense open and this view.
    const between = appSrc.slice(suspenseIdx, idx);
    assert.ok(!between.includes('</Suspense>'), `Suspense around <${name}> must not close early`);
  }
});

test('App imports Suspense and lazy from react', () => {
  assert.ok(appSrc.includes('Suspense'), 'App should import Suspense');
  assert.ok(appSrc.includes('lazy'), 'App should import lazy');
});
