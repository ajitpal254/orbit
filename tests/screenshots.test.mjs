// Screenshot checks — Orbit in a REAL browser at four widths.
//
// Why this file exists: v0.9.0's desktop bento density and the mobile
// layouts are only ever eyeballed on a phone after a deploy. This test
// boots the real server (in-memory MongoDB) and the real built
// frontend in Chromium, captures home / room / profile at 390 / 820 /
// 1440 / 2560px, and asserts the key elements actually render with no
// page errors. The PNGs land in tests/screenshots/ and CI uploads them
// as artifacts (see .github/workflows/ci.yml) so a human can eyeball
// them on the PR.
//
// What it does NOT do, deliberately: NO pixel-diff baselines. They
// are brittle — a one-pixel font or spacing change fails the suite
// without telling anyone anything useful. The assertions here are
// structural (the right landmarks render, no uncaught errors); the
// pixels are for human review via the CI artifact.
//
// Harness notes (same patterns as tests/smoke.test.mjs):
//   - Playwright Chromium: `npx playwright install chromium`.
//   - mongodb-memory-server: the server refuses to boot without a DB.
//   - Room creation is gated on verified email; with no SMTP here the
//     test flips the flag directly in its own throwaway database,
//     exactly what the verify link does.
//
// Ordering note: the profile shots run LAST. Profile has no back
// button of its own, and below 900px neither the icon rail nor the
// tab bar renders on that view (the tab bar only covers rooms /
// friends / messages), so on a phone there is no visible way back to
// Rooms from Profile at all. That is a real product gap, not a test
// artifact — the shots run last so the test never needs to navigate
// back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const ROOM_NAME = 'Screenshot Room';
const PASSWORD = 'screenshot-test-password-123';
const USERS = [
  { name: 'Shot Alice', email: 'shot-alice@example.test' },
  { name: 'Shot Bob', email: 'shot-bob@example.test' }
];
// Home / room / profile, mobile → ultrawide.
const VIEWPORTS = [390, 820, 1440, 2560];
const VIEWPORT_HEIGHT = 900;

const SHOT_DIR = new URL('./screenshots/', import.meta.url).pathname;

let mongod;
let mongoUri;
let serverProc;
let baseUrl;
let browser;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeout = 30000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr;
  for (;;) {
    try {
      const out = await fn();
      if (out) return out;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

before(async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  try {
    mongod = await MongoMemoryServer.create();
  } catch (err) {
    throw new Error(
      `Screenshot test needs mongodb-memory-server to start (it downloads a mongod binary once): ${err.message}`
    );
  }
  mongoUri = mongod.getUri();

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProc = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      MONGODB_URI: mongoUri,
      DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});

  await waitFor(async () => {
    const res = await fetch(`${baseUrl}/api/health`).catch(() => null);
    if (!res || !res.ok) return false;
    const body = await res.json();
    return body.db === 'connected' ? body : false;
  }, { timeout: 30000, label: `server health at ${baseUrl}` });

  try {
    browser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=WebRtcHideLocalIpsWithMdns'
      ]
    });
  } catch (err) {
    throw new Error(
      `Playwright could not launch Chromium: ${err.message}\n` +
      'Run `npx playwright install chromium` (CI: add that step to the workflow).'
    );
  }
});

after(async () => {
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  if (browser) await withTimeout(browser.close().catch(() => {}), 10000);
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (serverProc.exitCode === null) serverProc.kill('SIGKILL');
  }
  await withTimeout(mongoose.disconnect().catch(() => {}), 5000);
  if (mongod) await withTimeout(mongod.stop().catch(() => {}), 10000);
});

// Sign up through the real Auth form. Returns the logged-in page.
async function signUp(user) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page._shotErrors = pageErrors;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Email').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await page.getByPlaceholder('Name').fill(user.name);
  await page.getByPlaceholder('Email').fill(user.email);
  await page.getByPlaceholder(/Password \(min 12 characters\)/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'New room' }).waitFor({ timeout: 30000 });
  // First-run onboarding overlays home for a brand-new user — dismiss
  // it via the real Skip path so the room UI is clickable.
  const onboarding = page.getByRole('dialog', { name: 'Welcome to Orbit' });
  try {
    await onboarding.waitFor({ timeout: 3000 });
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await onboarding.waitFor({ state: 'detached', timeout: 5000 });
  } catch {
    // No onboarding overlay — nothing to dismiss.
  }
  return page;
}

test('screenshots: home / profile / room at 390 / 820 / 1440 / 2560', { timeout: 240000 }, async (t) => {
  let pageA;
  let pageB;

  await t.test('both users sign up and verify (test-only DB flip)', async () => {
    [pageA, pageB] = [await signUp(USERS[0]), await signUp(USERS[1])];
    const conn = await mongoose.createConnection(mongoUri).asPromise();
    try {
      const res = await conn.db.collection('users')
        .updateMany({}, { $set: { emailVerified: true } });
      assert.equal(res.modifiedCount, 2, 'both screenshot users must exist to verify');
    } finally {
      await conn.close();
    }
  });

  await t.test('home renders at every width', async () => {
    for (const width of VIEWPORTS) {
      await pageA.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      // Home landmark: the "New room" button. The rooms list itself
      // is empty for a fresh user — the bento/hero still renders.
      await pageA.getByRole('button', { name: 'New room' }).waitFor({ timeout: 10000 });
      await pageA.screenshot({ path: `${SHOT_DIR}home-${width}.png` });
      t.diagnostic(`home ${width}px captured`);
    }
  });

  await t.test('Alice creates a room, Bob joins it', async () => {
    await pageA.setViewportSize({ width: 1280, height: 720 });
    await pageA.getByRole('button', { name: 'New room' }).click();
    await pageA.getByPlaceholder(/Room name/).fill(ROOM_NAME);
    // Campfire is ON by default in the create form, and campfires by
    // design never produce a postcard (buildPostcard returns null for
    // ephemeral rooms) — the leave subtest below needs a permanent
    // room, so uncheck it here.
    const campfire = pageA.getByRole('checkbox', { name: /Campfire/ });
    await campfire.click();
    assert.equal(await campfire.isChecked(), false, 'campfire must be off so the room is permanent');
    await pageA.getByRole('button', { name: 'Create & drop in' }).click();
    await pageA.getByRole('button', { name: 'Mute', exact: true })
      .waitFor({ timeout: 30000 });

    await pageB.setViewportSize({ width: 1280, height: 720 });
    await pageB.getByRole('button', { name: new RegExp(ROOM_NAME) })
      .waitFor({ timeout: 30000 });
    await pageB.evaluate((name) => {
      const card = [...document.querySelectorAll('.room-card')]
        .find((b) => b.textContent.includes(name));
      if (!card) throw new Error(`room card for ${name} not found`);
      card.click();
    }, ROOM_NAME);
    await pageB.getByRole('button', { name: 'Mute', exact: true })
      .waitFor({ timeout: 30000 });
    // Both sides see the other's orb before any shot is taken.
    for (const page of [pageA, pageB]) {
      await page.getByRole('button', { name: 'Connection details' })
        .waitFor({ timeout: 30000 });
    }
  });

  await t.test('room renders at every width', async () => {
    for (const width of VIEWPORTS) {
      await pageA.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      // Room landmarks: the voice bar (Mute) and the other orb.
      await pageA.getByRole('button', { name: 'Mute', exact: true })
        .waitFor({ timeout: 10000 });
      await pageA.getByRole('button', { name: new RegExp(`^${USERS[1].name}`) })
        .waitFor({ timeout: 10000 });
      await pageA.screenshot({ path: `${SHOT_DIR}room-${width}.png` });
      t.diagnostic(`room ${width}px captured`);
    }
  });

  await t.test('Alice leaves the room (postcard dismissed)', async () => {
    await pageA.setViewportSize({ width: 1280, height: 720 });
    await pageA.getByRole('button', { name: 'Leave room' }).click();
    const card = pageA.getByRole('dialog', { name: `Recap of ${ROOM_NAME}` });
    await card.waitFor({ timeout: 10000 });
    await pageA.getByRole('button', { name: 'Dismiss postcard' }).click();
    await card.waitFor({ state: 'detached', timeout: 5000 });
    await pageA.getByRole('button', { name: 'New room' }).waitFor({ timeout: 10000 });
  });

  await t.test('profile renders at every width', async () => {
    for (const width of VIEWPORTS) {
      await pageA.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      // Profile is reached from the icon rail (desktop, >=900px) or
      // the topbar avatar (mobile); only one is visible at a time,
      // so the role query resolves to whichever the layout shows.
      // exact: true matters — without it 'Profile' also matches the
      // 'Save profile' button on this very view (strict-mode
      // violation on the second width, once the view is showing).
      // No back-navigation here by design — see the ordering note at
      // the top of this file.
      await pageA.getByRole('button', { name: 'Profile', exact: true }).click();
      await pageA.getByRole('button', { name: 'Save profile' }).waitFor({ timeout: 10000 });
      await pageA.screenshot({ path: `${SHOT_DIR}profile-${width}.png` });
      t.diagnostic(`profile ${width}px captured`);
    }
  });

  await t.test('no uncaught page errors on either side', async () => {
    for (const [page, who] of [[pageA, 'Alice'], [pageB, 'Bob']]) {
      assert.deepEqual(page._shotErrors, [], `${who}'s page must have no uncaught errors`);
      await page.context().close();
    }
  });
});
