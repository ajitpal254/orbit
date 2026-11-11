import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression test for the v0.2.0 live crash (2026-11-11): the app
// rendered a blank screen with
// "Uncaught ReferenceError: Cannot access 'ue' before initialization"
// because handleNotifNavigate's dependency array ([joinRoom, goTo]) was
// evaluated on the first render while joinRoom and goTo — declared
// later in App.jsx — were still in the temporal dead zone. The v0.2.0
// merge had moved handleNotifNavigate above them. A hook's dependency
// array is evaluated when the hook runs, so every const it names must
// be declared before the hook call in the same component.
const src = readFileSync(new URL('../frontend/src/App.jsx', import.meta.url), 'utf8');

const declPos = (name) => {
  const i = src.indexOf(`const ${name} =`);
  assert.ok(i >= 0, `${name} should be declared in App.jsx`);
  return i;
};

test('joinRoom and goTo are declared before handleNotifNavigate', () => {
  const joinRoom = declPos('joinRoom');
  const goTo = declPos('goTo');
  const nav = declPos('handleNotifNavigate');
  assert.ok(joinRoom < nav, 'joinRoom must be declared before handleNotifNavigate');
  assert.ok(goTo < nav, 'goTo must be declared before handleNotifNavigate');
});

test('deep-link effect (also deps on joinRoom/goTo) comes after them', () => {
  const joinRoom = declPos('joinRoom');
  const goTo = declPos('goTo');
  const effectDeps = src.indexOf('[user, joinRoom, goTo]');
  assert.ok(effectDeps > 0, 'deep-link effect should list [user, joinRoom, goTo]');
  assert.ok(effectDeps > joinRoom, 'deep-link effect must come after joinRoom');
  assert.ok(effectDeps > goTo, 'deep-link effect must come after goTo');
});
