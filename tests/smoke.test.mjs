// Smoke test — Orbit end to end in a REAL browser.
//
// Why this file exists: v0.6.0 shipped a live-breaking audio regression
// (a TURN design Metered rejects) that no existing test caught, because
// nothing exercised the deployed app end to end. This test boots the real
// server (in-memory MongoDB) and drives the real built frontend in a real
// Chromium via Playwright: two users sign up, one creates a room, the
// other joins, and the voice path is exercised as far as the environment
// allows (see the limits below).
//
// What it needs (all dev-only, never shipped):
//   - Playwright Chromium: `npx playwright install chromium`
//     (CI: add that step to the workflow — this file does NOT install
//     browsers itself). Headless shell is enough; it has minimal system
//     deps and is what `chromium.launch()` uses headless.
//   - mongodb-memory-server: downloads a mongod binary once
//     (~/.cache/mongodb-binaries) and runs it in-process. The server
//     exits at boot without MongoDB, so there is no DB-less way to run
//     the real app.
//
// What it PROVES (all asserted):
//   - The server boots against a real database and serves health +
//     the built frontend bundle.
//   - A brand-new user can sign up and reach home (this caught a real
//     bug on first run: NightSky called useMemo after an early return,
//     so a fresh account with no friends crashed the whole app to a
//     blank screen — see NightSky.jsx).
//   - Two users can be in the same room and see each other's orbs
//     (socket join-room + room-state + user-joined round trips).
//   - The voice engine starts on both sides: each side creates a peer
//     connection, offers/answers are exchanged over the socket, ICE
//     gathering runs (host candidates), and the connection leaves
//     'new' — i.e. checks start. This is the state the v0.6.0 incident
//     never reached in the broken direction (no relay candidate ever
//     gathered); a signaling or gathering regression fails here.
//   - The two-user product flows, end to end through the real UI
//     (v0.9.1): friend request → accept, DM send, invite link →
//     join, knock → admit on a private room, and the room postcard
//     on leave (both sides).
//   - Mic mute round-trips over the socket (orb mic-off badge).
//   - When an account TURN is configured (/api/turn serves a
//     credential), a real relay candidate is gathered through it —
//     the check that WOULD have caught the v0.6.0 bug itself.
//
// What it does NOT prove — sandbox limits, stated plainly:
//   - `connected` voice: this sandbox blocks UDP sockets entirely
//     (a UDP datagram sent to loopback never arrives; verified with
//     node:dgram and a raw socket) and its egress proxy intercepts
//     all non-HTTP(S) TCP, answering TURN/STUN handshakes with a
//     denial — so no relay candidate can ever be gathered here and
//     no peer connection can complete. The test measures UDP with a
//     loopback probe: where UDP works (e.g. CI runners) it REQUIRES
//     `connected`; where UDP is blocked it requires the connection
//     to leave 'new' (signaling + gathering + checks started) and
//     logs the ceiling instead of faking a pass.
//   - Real devices: no physical mic/speaker, no mobile Safari, no
//     PWA install, no push delivery. Those still need a phone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const ROOM_NAME = 'Smoke Room';
const PASSWORD = 'smoke-test-password-123';
const USERS = [
  { name: 'Smoke Alice', email: 'smoke-alice@example.test' },
  { name: 'Smoke Bob', email: 'smoke-bob@example.test' }
];

let mongod;
let mongoUri;
let serverProc;
let baseUrl;
let browser;
// Measured in before(): can this machine actually move UDP? The
// sandbox cannot (loopback datagrams never arrive); CI runners can.
// The voice assertion branches on it — see the peer test below.
let udpAvailable = false;

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

// UDP loopback round trip: bind, send a datagram to self, await it.
// False when sockets are blocked (sandbox) or the datagram never
// arrives — never throws, so a weird network fails closed to the
// weaker assertion instead of failing the suite.
async function probeUdp(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch {} resolve(v); } };
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => finish(false));
    sock.on('message', () => finish(true));
    try {
      sock.bind(0, '127.0.0.1', () => {
        try { sock.send(Buffer.from('smoke'), sock.address().port, '127.0.0.1'); } catch { finish(false); }
      });
    } catch { finish(false); }
    setTimeout(() => finish(false), timeoutMs);
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
  udpAvailable = await probeUdp();
  // In-memory MongoDB: the server refuses to boot without a database.
  try {
    mongod = await MongoMemoryServer.create();
  } catch (err) {
    throw new Error(
      `Smoke test needs mongodb-memory-server to start (it downloads a mongod binary once): ${err.message}`
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
      // A real (random, throwaway) key so the server does not fall back
      // to its ephemeral-key warning path.
      DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      // The music fixture is a local HTTP server (127.0.0.1), so the
      // audio proxy's SSRF guard needs its test-only escape hatch.
      ALLOW_PRIVATE_STREAM_HOSTS: '1'
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
        // Fake mic so getUserMedia succeeds headless; the peer
        // connection then has a real audio track to negotiate.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // Chromium hides literal local IPs behind mDNS *.local names
        // by default; this sandbox has no mDNS responder, so those
        // candidates can never resolve and the connection sits at
        // 'new' forever. Literal host IPs let checks start wherever
        // UDP works at all.
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
  // Defensive timeouts: a hung browser/mongod must not hang the suite.
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
  page._smokeErrors = pageErrors;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  // Splash boots /api/auth/me, then the Auth form appears.
  await page.getByPlaceholder('Email').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await page.getByPlaceholder('Name').fill(user.name);
  await page.getByPlaceholder('Email').fill(user.email);
  await page.getByPlaceholder(/Password \(min 12 characters\)/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  // Home: the "New room" button is the logged-in landmark.
  await page.getByRole('button', { name: 'New room' }).waitFor({ timeout: 30000 });
  // First-run onboarding (v0.7.0) overlays home for a brand-new user
  // and covers the room UI — dismiss it via the real Skip path so the
  // room UI is clickable. Returning users never see it; the wait times
  // out quietly for them.
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

test('smoke: two users join a room and voice starts', { timeout: 240000 }, async (t) => {
  t.diagnostic(`UDP available in this environment: ${udpAvailable}`);
  await t.test('server serves health + built frontend', async () => {
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.db, 'connected');

    const html = await (await fetch(`${baseUrl}/`)).text();
    const asset = html.match(/\/assets\/index-[^"']+\.js/)?.[0];
    assert.ok(asset, 'index.html must reference a built JS bundle');
    const bundle = await fetch(`${baseUrl}${asset}`);
    assert.equal(bundle.status, 200, `built bundle ${asset} must be served`);
  });

  let pageA;
  let pageB;
  await t.test('both users sign up and verify (test-only DB flip)', async () => {
    [pageA, pageB] = [await signUp(USERS[0]), await signUp(USERS[1])];
    // Room creation is gated on verified email (audit M1) and there is
    // no SMTP in this sandbox, so the test flips the flag directly in
    // its own throwaway database — exactly what the verify link does.
    const conn = await mongoose.createConnection(mongoUri).asPromise();
    try {
      const res = await conn.db.collection('users')
        .updateMany({}, { $set: { emailVerified: true } });
      assert.equal(res.modifiedCount, 2, 'both smoke users must exist to verify');
    } finally {
      await conn.close();
    }
  });

  await t.test('friend request → accept through the Friends UI', async () => {
    // Alice finds Bob by email and sends the request.
    await pageA.getByRole('button', { name: 'Friends' }).click();
    await pageA.getByPlaceholder('Search by name or email…').fill(USERS[1].email);
    await pageA.getByRole('button', { name: 'Add', exact: true }).waitFor({ timeout: 10000 });
    await pageA.getByRole('button', { name: 'Add', exact: true }).click();
    await pageA.getByText('Requested').first().waitFor({ timeout: 10000 });

    // Bob sees the request and accepts it.
    await pageB.getByRole('button', { name: 'Friends' }).click();
    await pageB.getByText('Requests for you').waitFor({ timeout: 10000 });
    await pageB.getByRole('button', { name: 'Accept', exact: true }).click();
    await pageB.getByText(USERS[0].name).waitFor({ timeout: 10000 });

    // Alice's list refreshes to show Bob as a friend (remount the view).
    await pageA.getByRole('button', { name: 'Rooms' }).click();
    await pageA.getByRole('button', { name: 'Friends' }).click();
    await pageA.getByText(USERS[1].name).waitFor({ timeout: 10000 });
  });

  await t.test('DM send through the Messages UI', async () => {
    // Alice opens a DM from Bob's row on the Friends tab.
    await pageA.getByRole('button', { name: 'Message', exact: true }).click();
    await pageA.getByPlaceholder(`Message ${USERS[1].name}…`).fill('smoke dm hello');
    await pageA.getByRole('button', { name: 'Send', exact: true }).click();
    await pageA.getByText('smoke dm hello').waitFor({ timeout: 10000 });

    // Bob opens the thread from his Messages list and sees it.
    await pageB.getByRole('button', { name: 'Messages' }).click();
    await pageB.getByRole('button', { name: new RegExp(USERS[0].name) }).click();
    await pageB.getByText('smoke dm hello').waitFor({ timeout: 10000 });

    // Back to the rooms list on both sides for the room flows.
    for (const page of [pageA, pageB]) {
      await page.getByRole('button', { name: 'Rooms' }).click();
      await page.getByRole('button', { name: 'New room' }).waitFor({ timeout: 10000 });
    }
  });

  await t.test('Alice creates a room, Bob joins it', async () => {
    await pageA.getByRole('button', { name: 'New room' }).click();
    await pageA.getByPlaceholder(/Room name/).fill(ROOM_NAME);
    // Campfire is ON by default in the create form, and campfires by
    // design never produce a postcard (buildPostcard returns null for
    // ephemeral rooms) — the leave → postcard subtests below need a
    // permanent room, so uncheck it here.
    const campfire = pageA.getByRole('checkbox', { name: /Campfire/ });
    await campfire.click();
    assert.equal(await campfire.isChecked(), false, 'campfire must be off so the room is permanent');
    await pageA.getByRole('button', { name: 'Create & drop in' }).click();
    // Room view: mic affordance present, alone hint shown.
    await pageA.getByRole('button', { name: 'Mute', exact: true })
      .waitFor({ timeout: 30000 });
    await pageA.getByText("You're alone in here").waitFor({ timeout: 10000 });

    // Bob sees the live room on home and joins from its card. A plain
    // Playwright click is flaky here (the card's stagger-in animation
    // + live list re-renders keep detaching it), so click the DOM node
    // directly — the app's onClick still fires.
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
    // Both sides see the other's orb: room-state + user-joined arrived.
    for (const page of [pageA, pageB]) {
      await page.getByRole('button', { name: 'Connection details' })
        .waitFor({ timeout: 30000 });
    }
  });

  await t.test('chat message stamps activity + room recency (v0.9.0 density)', async () => {
    // Alice sends one chat message through the real UI (REST path —
    // RoomView posts to /api/rooms/:id/messages); the socket path
    // stamps the same field, see lib/socket.js chat-message.
    const today = new Date().toISOString().slice(0, 10);
    await pageA.getByRole('button', { name: 'Chat', exact: true }).click();
    await pageA.getByPlaceholder(`Message ${ROOM_NAME}…`).fill('smoke hello');
    await pageA.getByRole('button', { name: 'Send', exact: true }).click();
    await pageA.getByText('smoke hello').waitFor({ timeout: 10000 });

    // GET /api/me/activity: today is active, at least one message.
    const activity = await pageA.evaluate(async () => {
      const res = await fetch('/api/me/activity');
      if (!res.ok) throw new Error(`activity ${res.status}`);
      return res.json();
    });
    assert.ok(activity.days.includes(today), `today (${today}) must be in the active days: ${JSON.stringify(activity.days)}`);
    assert.ok(activity.messageCount >= 1, `expected at least 1 message, got ${activity.messageCount}`);

    // GET /api/rooms: the room carries a fresh lastActiveAt.
    const rooms = await pageA.evaluate(async () => {
      const res = await fetch('/api/rooms');
      if (!res.ok) throw new Error(`rooms ${res.status}`);
      return res.json();
    });
    const room = rooms.find((r) => r.name === ROOM_NAME);
    assert.ok(room, 'the smoke room must be listed');
    assert.ok(room.lastActiveAt, 'the room must carry lastActiveAt');
    assert.ok(Date.now() - new Date(room.lastActiveAt).getTime() < 5 * 60 * 1000, `lastActiveAt must be fresh, got ${room.lastActiveAt}`);
  });

  await t.test('peer connections leave new (voice path starts)', async () => {
    // Each side shows the other in the Connection details popover as
    // "<connectionState> / <iceConnectionState> (<candidate types>)".
    // Leaving 'new' proves: the peer connection was created, the
    // offer/answer exchange ran over the socket, ICE gathering ran
    // (host candidates appear), and connectivity checks started.
    // Where UDP works this must go all the way to connected /
    // connected; where UDP is blocked (this sandbox) checks start
    // and then fail for lack of a transport — that ceiling is an
    // environment limit, not an app failure, and is logged, not hidden.
    for (const [page, peerName] of [[pageA, USERS[1].name], [pageB, USERS[0].name]]) {
      await page.getByRole('button', { name: 'Connection details' }).click();
      const popover = page.getByRole('dialog', { name: 'Connection details' });
      const text = await waitFor(async () => {
        const cur = (await popover.textContent()) || '';
        // A row for the peer exists once the engine reports it; the
        // states start at "— / —" until the first report lands.
        // Match REAL state words, not \S+: the row renders the peer
        // name and the state in adjacent <span>s, so textContent
        // glues them ("Smokenew / new (host+srflx)") and \S+ captured
        // "Smokenew" — neither '—' nor 'new' — so the wait returned
        // on the first poll before the connection had moved at all
        // (CI failed the connected assertion 87ms in). Enumerating
        // the RTC state vocabulary makes m[1] the true state.
        const m = cur.match(/(new|connecting|connected|disconnected|failed|closed) \/ (new|checking|connected|completed|disconnected|failed|closed) \(([^)]*)\)/);
        if (!m || m[1] === 'new') return false;
        // With UDP, wait for the real thing — connected / connected —
        // not just "not new": the assertion below reads this same
        // text, and catching 'checking' on the first poll would fail
        // it before the connection finishes. Without UDP, leaving
        // 'new' (checks started) is the honest ceiling.
        if (udpAvailable && !(m[1] === 'connected' && m[2] === 'connected')) return false;
        return cur;
      }, { timeout: 30000, label: `${peerName} peer connection leaving new` });
      t.diagnostic(`peer state seen by ${peerName === USERS[1].name ? 'Alice' : 'Bob'}: ${text.trim()}`);
      assert.match(text, /\(([^)]*host[^)]*)\)/,
        'peer must have gathered host candidates (signaling + ICE gathering ran)');
      if (udpAvailable) {
        assert.match(text, /connected \/ connected/,
          'with UDP available the peer connection must reach connected');
      } else {
        t.diagnostic('UDP is blocked in this environment — connected is not reachable here; leaving new (checks started) is the honest ceiling. CI runners with UDP must reach connected (asserted above when udpAvailable).');
      }
    }
  });

  await t.test('mic mute round-trips over the socket', async () => {
    // A muted orb shows the mic-off badge (.orb-muted); the "Muted"
    // text only appears in the selected-orb popover, so the badge is
    // the assertion. Bob's page must show exactly one (Alice's).
    await pageA.getByRole('button', { name: 'Mute', exact: true }).click();
    await pageA.getByRole('button', { name: 'Unmute', exact: true })
      .waitFor({ timeout: 10000 });
    await pageB.locator('.orb-muted').first().waitFor({ timeout: 10000 });
    assert.equal(await pageB.locator('.orb-muted').count(), 1);
    await pageA.getByRole('button', { name: 'Unmute', exact: true }).click();
    await pageA.getByRole('button', { name: 'Mute', exact: true })
      .waitFor({ timeout: 10000 });
    await pageB.locator('.orb-muted').waitFor({ state: 'detached', timeout: 10000 });
  });

  await t.test('invite link → join through the real link', async () => {
    // Alice opens the invite-link panel and reads the shareable URL.
    await pageA.getByRole('button', { name: 'Copy invite link' }).click();
    const linkUrl = await waitFor(async () => {
      // NOTE: getByLabel('Invite link') is unusable here — it
      // substring-matches the header's 'Copy invite link' button and
      // the panel's 'Close invite link' button too (3 matches, strict
      // mode throws). The input is the only textbox with that name.
      // inputValue gets a SHORT timeout: without it a single poll
      // blocks Playwright's default 30s while the panel is still
      // rendering, which blows the waitFor deadline from inside the
      // poll (seen in CI: the 15s wait reported its timeout at 30s).
      const value = await pageA.getByRole('textbox', { name: 'Invite link', exact: true }).inputValue({ timeout: 1000 }).catch(() => '');
      return value || false;
    }, { timeout: 60000, label: 'invite link URL to appear' });
    assert.match(linkUrl, /#invite-/, `invite link must carry a token hash, got ${linkUrl}`);

    // Bob leaves, dismisses his postcard, then follows the link: the
    // app redeems the token from the hash and drops him back in.
    // Leave via the voice-bar button (aria-label), NOT the role query:
    // a private room ALSO has a members-panel 'Leave room' text button
    // (membership leave, with a confirm dialog), and the role query
    // matches both — strict-mode violation. The voice-bar button is
    // the call-leave path that builds the postcard.
    await pageB.locator('button[aria-label="Leave room"]').click();
    const bobCard = pageB.getByRole('dialog', { name: `Recap of ${ROOM_NAME}` });
    await bobCard.waitFor({ timeout: 30000 });
    assert.match(await bobCard.textContent(), new RegExp(USERS[0].name),
      "Bob's postcard must name Alice, who he was in the room with");
    await pageB.getByRole('button', { name: 'Dismiss postcard' }).click();
    await bobCard.waitFor({ state: 'detached', timeout: 5000 });

    await pageB.goto(linkUrl);
    // The join POST shares the server's per-IP rate-limit budget
    // (120/min, rolling) with every poll both pages make — Home
    // refreshes presence every 5s — so on a fast run it can
    // legitimately 429. That is the limiter doing its job, not a
    // broken link: retry the link, waiting out the rolling window,
    // and only fail on a non-429 outcome or after the retries.
    let joined = false;
    let lastOutcome = '';
    for (let attempt = 0; attempt < 4 && !joined; attempt++) {
      if (attempt > 0) {
        await pageB.getByRole('button', { name: 'Dismiss' }).click().catch(() => {});
        await pageB.waitForTimeout(20000);
        await pageB.goto(linkUrl);
      }
      const outcome = await waitFor(async () => {
        if (await pageB.getByRole('button', { name: 'Mute', exact: true }).isVisible().catch(() => false)) return 'joined';
        const alert = pageB.locator('.invite-error');
        if (await alert.isVisible().catch(() => false)) return `error: ${(await alert.textContent())?.trim()}`;
        return false;
      }, { timeout: 60000, label: 'Bob rejoining via the invite link' });
      lastOutcome = outcome;
      if (outcome === 'joined') joined = true;
      else if (!outcome.includes('Too many requests')) break;
      else t.diagnostic(`invite join attempt ${attempt + 1} rate-limited, retrying after a wait`);
    }
    assert.equal(lastOutcome, 'joined', `invite-link join failed — ${lastOutcome}`);
    // Alice sees Bob's orb again — no rejoin from her side.
    await pageA.getByRole('button', { name: new RegExp(`^${USERS[1].name}`) })
      .waitFor({ timeout: 10000 });
  });

  await t.test('navigating away mid-call keeps the call alive (v0.9.0)', async () => {
    // The call is owned by App.jsx, not the room view: leaving the
    // room view for another section hides it (RoomView stays mounted)
    // and the mini-player takes over — the session must not end.
    //
    // Viewport note: mid-call navigation is only reachable through
    // visible UI at tablet width (521–899px). On desktop the topbar
    // bell/avatar are display:none and the icon rail hides in-room;
    // on phones the bell hides too — so this subtest resizes Alice's
    // page to 800px, where the topbar bell is visible. (That desktop/
    // phone gap — no visible way to leave the room view without
    // leaving the call — is a real product gap, reported separately;
    // this task's job is that the call survives navigation where it
    // is reachable.)
    await pageA.keyboard.press('Escape'); // close the Connection details popover, if open
    await pageA.setViewportSize({ width: 800, height: 1000 });
    try {
      // Bell (topbar) -> notifications: the room hides, the
      // mini-player takes over the same call.
      await pageA.getByRole('button', { name: /^Notifications/ }).click();
      await pageA.locator('.mini-player').waitFor({ timeout: 10000 });
      // The room view is hidden, not unmounted: the room's voice bar
      // is gone (the MiniPlayer has its own Mute button, so scope
      // this to .voice-bar), the mini-player is showing the same call.
      await pageA.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true })
        .waitFor({ state: 'hidden', timeout: 10000 });
      // Back to the rooms list, then Friends, then Messages — the
      // mini-player (and the call) must survive every hop.
      await pageA.getByRole('button', { name: 'Back', exact: true }).click();
      for (const section of ['Friends', 'Messages']) {
        await pageA.getByRole('button', { name: section, exact: true }).click();
        await pageA.locator('.mini-player').waitFor({ state: 'visible', timeout: 10000 });
      }
      // Bob still sees Alice in the room the whole time — no
      // leave/join flicker (the server grace + the kept session).
      await pageB.getByRole('button', { name: new RegExp(`^${USERS[0].name}`) })
        .waitFor({ timeout: 10000 });
      // Tap the mini-player to return: the room view and voice bar
      // come back, same call (no rejoin).
      await pageA.locator('.mini-player').click();
      await pageA.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true })
        .waitFor({ timeout: 10000 });
    } finally {
      await pageA.setViewportSize({ width: 1280, height: 720 });
    }
  });

  await t.test('minimize button hides the room view and keeps the call alive (v0.9.0)', async () => {
    // The minimize control (RoomView header, all widths) leaves the
    // room VIEW without leaving the call — it closes the gap the
    // persistent-call spec flagged: on desktop/phones there was no
    // visible way to do this at all. At 1280px the bell/rail paths
    // are hidden, so this is the only in-room exit that keeps the
    // call. Same assertions as the navigation subtest, driven by
    // the button instead of the bell.
    await pageA.keyboard.press('Escape'); // close any open popover
    await pageA.setViewportSize({ width: 1280, height: 720 });
    await pageA.getByRole('button', { name: 'Minimize room view, keep call running' }).click();
    await pageA.locator('.mini-player').waitFor({ timeout: 10000 });
    await pageA.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true })
      .waitFor({ state: 'hidden', timeout: 10000 });
    // Bob still sees Alice in the room — no leave/join flicker.
    await pageB.getByRole('button', { name: new RegExp(`^${USERS[0].name}`) })
      .waitFor({ timeout: 10000 });
    // Tap the mini-player to return: the room view and voice bar
    // come back, same call (no rejoin).
    await pageA.locator('.mini-player').click();
    await pageA.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true })
      .waitFor({ timeout: 10000 });
  });

  await t.test('TURN relay: real relay candidate when an account TURN exists', async () => {
    // The peer connection above proves signaling + ICE work over host
    // candidates. It CANNOT prove the TURN relay works — the v0.6.0
    // bug was exactly "relay credential rejected, no relay candidate
    // ever gathered". So when /api/turn serves a credential
    // (METERED_* env set), gather a relay candidate through it here;
    // without one this logs a skip instead of faking the check.
    const turn = await pageA.evaluate(async () => {
      const res = await fetch('/api/turn', { credentials: 'include' });
      return res.json();
    });
    if (!turn?.turn) {
      t.diagnostic('TURN: /api/turn returned no credential (no METERED_* env) — relay-candidate check SKIPPED. Peer-connection assertion above only covers host candidates.');
      return;
    }
    const relay = await pageA.evaluate(async (iceServers) => {
      const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
      pc.createDataChannel('smoke');
      const gathered = new Promise((resolve) => {
        const found = [];
        pc.onicecandidate = (e) => {
          if (!e.candidate) return resolve(found);
          found.push(e.candidate.candidate);
        };
        setTimeout(() => resolve(found), 20000);
      });
      await pc.createOffer().then((o) => pc.setLocalDescription(o));
      const candidates = await gathered;
      pc.close();
      return candidates.filter((c) => c.includes('typ relay'));
    }, [turn.turn]);
    assert.ok(relay.length > 0,
      `expected a relay candidate from /api/turn credentials, got none — the TURN relay is not allocating (this is the v0.6.0 failure mode)`);
    t.diagnostic(`TURN: relay candidate gathered: ${relay[0]}`);
  });

  await t.test('leaving shows the room postcard (Alice leaves the Smoke Room)', async () => {
    await pageA.locator('button[aria-label="Leave room"]').click();
    const card = pageA.getByRole('dialog', { name: `Recap of ${ROOM_NAME}` });
    await card.waitFor({ timeout: 10000 });
    assert.match(await card.textContent(), new RegExp(USERS[1].name),
      "Alice's postcard must name Bob, who she was in the room with");
    await pageA.getByRole('button', { name: 'Dismiss postcard' }).click();
    await card.waitFor({ state: 'detached', timeout: 5000 });
    await pageA.getByRole('button', { name: 'New room' }).waitFor({ timeout: 10000 });
  });

  const PRIVATE_ROOM_NAME = 'Smoke Private Room';
  await t.test('knock → admit on a private room', async () => {
    // Alice creates a private room; only members can see it, so Bob
    // reaches it through the room deep link and gets the locked screen.
    await pageA.getByRole('button', { name: 'New room' }).click();
    await pageA.getByPlaceholder(/Room name/).fill(PRIVATE_ROOM_NAME);
    await pageA.getByRole('button', { name: 'Private', exact: true }).click();
    // Same campfire default as the Smoke Room: uncheck it so the
    // room is permanent and Bob's leave shows a postcard.
    const campfire = pageA.getByRole('checkbox', { name: /Campfire/ });
    await campfire.click();
    assert.equal(await campfire.isChecked(), false, 'campfire must be off so the room is permanent');
    await pageA.getByRole('button', { name: 'Create & drop in' }).click();
    // 60s, not 30s: under the full suite's parallel load, joining a
    // room can take well over 30s (CI failed here at exactly 30s).
    await pageA.getByRole('button', { name: 'Mute', exact: true })
      .waitFor({ timeout: 60000 });

    const privateRoomId = await pageA.evaluate(async (name) => {
      const res = await fetch('/api/rooms');
      if (!res.ok) throw new Error(`rooms ${res.status}`);
      const rooms = await res.json();
      const room = rooms.find((r) => r.name === name);
      if (!room) throw new Error(`private room ${name} not listed`);
      return room.id;
    }, PRIVATE_ROOM_NAME);

    // Bob leaves the Smoke Room first so his stay there ends cleanly,
    // then opens the private room's deep link.
    await pageB.locator('button[aria-label="Leave room"]').click();
    const smokeCard = pageB.getByRole('dialog', { name: `Recap of ${ROOM_NAME}` });
    await smokeCard.waitFor({ timeout: 30000 });
    await pageB.getByRole('button', { name: 'Dismiss postcard' }).click();
    await smokeCard.waitFor({ state: 'detached', timeout: 5000 });

    await pageB.goto(`${baseUrl}/#room-${privateRoomId}`);
    await pageB.getByRole('button', { name: 'Knock to join' })
      .waitFor({ timeout: 30000 });
    await pageB.getByRole('button', { name: 'Knock to join' }).click();
    await pageB.getByText('You knocked').waitFor({ timeout: 30000 });

    // Alice answers from the members panel; Bob joins live.
    await pageA.getByRole('button', { name: 'Admit', exact: true })
      .waitFor({ timeout: 30000 });
    await pageA.getByRole('button', { name: 'Admit', exact: true }).click();
    // If the admit itself fails (rate limit, server error) the panel
    // shows the error and Bob never joins — surface that text instead
    // of timing out silently on Bob's Mute button below.
    await pageA.waitForTimeout(3000);
    const knockError = await pageA.evaluate(() => {
      const el = document.querySelector('.knocks-section .error, .members-panel .error');
      return el ? el.textContent : '';
    });
    assert.equal(knockError, '', `admitting the knock must not error, got: ${knockError}`);
    await pageB.getByRole('button', { name: 'Mute', exact: true })
      .waitFor({ timeout: 60000 });
    await pageA.getByRole('button', { name: new RegExp(`^${USERS[1].name}`) })
      .waitFor({ timeout: 30000 });
  });

  // A tiny generated WAV (10s, 440Hz sine, 8kHz mono) as a data: URL
  // — a playable radio track the test server never has to serve, and
  // never a real YouTube URL. Long enough that the DJ's element does
  // not hit 'ended' (and auto-skip) mid-assertion. Returned as a
  // Buffer: the server only queues http(s) URLs, so the subtest
  // serves these bytes over a tiny local HTTP server instead of a
  // data: URL (which validateTrack rejects).
  function makeWavBuffer(seconds = 10) {
    const sampleRate = 8000;
    const n = sampleRate * seconds;
    const data = Buffer.alloc(44 + n * 2);
    data.write('RIFF', 0);
    data.writeUInt32LE(36 + n * 2, 4);
    data.write('WAVE', 8);
    data.write('fmt ', 12);
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20); // PCM
    data.writeUInt16LE(1, 22); // mono
    data.writeUInt32LE(sampleRate, 24);
    data.writeUInt32LE(sampleRate * 2, 28);
    data.writeUInt16LE(2, 32);
    data.writeUInt16LE(16, 34);
    data.write('data', 36);
    data.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      const s = Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
      data.writeInt16LE(s, 44 + i * 2);
    }
    return data;
  }

  await t.test('music bot: DJ claims, queues a radio track, both sides see now-playing (v0.10.0)', async (st) => {
    // The music routes live in the backend half of v0.10.0. If this
    // build has no music backend yet, skip instead of failing the
    // frontend's suite on a missing server half — the probe is a
    // POST to a route that only exists with the backend (unknown
    // /api paths answer JSON 404, never the SPA page). With the
    // backend merged this probe answers 400/403 and the full flow
    // below runs.
    const probe = await pageA.evaluate(async () => {
      // Refresh the CSRF cookie first (like api.js ensureCsrfToken):
      // the CSRF middleware runs before the /api 404 handler, so a
      // POST with a stale token would 403 even with no music backend.
      await fetch('/api/auth/csrf-token', { credentials: 'include' }).catch(() => {});
      const token = document.cookie.split('; ').find((c) => c.startsWith('csrfToken='))?.split('=')[1] || '';
      const res = await fetch('/api/music/youtube', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ url: 'not a url', roomId: 'probe' })
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    });
    if (probe.status === 404) {
      t.diagnostic('music backend not present in this build (POST /api/music/youtube -> 404) — DJ/queue/state assertions need the server half; voice-track negotiation is covered by tests/musicVoice.test.mjs');
      st.skip('music backend not present in this build');
      return;
    }
    t.diagnostic(`music backend probe: POST /api/music/youtube -> ${probe.status} ${JSON.stringify(probe.body)}`);

    // Both sides open the Music panel first — the DJ line and the
    // now-playing row only render inside it.
    for (const page of [pageA, pageB]) {
      await page.getByRole('button', { name: 'Music', exact: true }).click();
      await page.getByLabel('Track URL').waitFor({ timeout: 10000 });
    }

    // Alice takes the DJ seat; the claim broadcasts to the room.
    // Scope to the Music panel: the same "DJ: <name>" line also
    // renders in the Music Bot members-list row, and an unscoped
    // getByText hits both (Playwright strict-mode violation).
    await pageA.getByRole('button', { name: 'Take over as DJ' }).click();
    for (const page of [pageA, pageB]) {
      await page.getByRole('region', { name: 'Music' }).getByText(`DJ: ${USERS[0].name}`).waitFor({ timeout: 10000 });
    }

    // Alice queues the generated tone as a radio track, then plays.
    // The queue-add and the play both broadcast music-state; the DJ
    // client reacts by loading the URL and streaming it into the mesh.
    // Serve the generated tone over a tiny local HTTP server: the
    // queue only accepts http(s) URLs, and this is a real radio-style
    // stream URL with no external dependency.
    const wav = makeWavBuffer();
    const fixture = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      res.end(wav);
    });
    // TEMP: always close the fixture even if an assertion below fails,
    // or the listening server keeps the test process alive forever.
    st.after(() => { try { fixture.close(); } catch {} });
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/tone.wav`;
    await pageA.getByLabel('Track URL').fill(fixtureUrl);
    await pageA.getByLabel('Track title').fill('Smoke Tone');
    await pageA.getByRole('button', { name: 'Add track' }).click();
    await pageA.getByText('Smoke Tone').first().waitFor({ timeout: 10000 });
    await pageA.getByRole('button', { name: 'Play music' }).click();
    for (const page of [pageA, pageB]) {
      await page.getByText('Now playing').waitFor({ timeout: 10000 });
      await page.getByText('Smoke Tone').first().waitFor({ timeout: 10000 });
    }

    // Bob's engine got a second audio track from Alice (the music
    // track, negotiated by renegotiation after the DJ started
    // streaming) — the panel's "Live in the room" line is the
    // user-visible proof of it. Renegotiation is signaling-only, so
    // it works even where UDP is blocked and the voice connection
    // itself never reaches 'connected'.
    await pageB.locator('.music-live').waitFor({ timeout: 30000 });
    assert.match(await pageB.locator('.music-live').first().textContent(), /Live in the room/);

    // The Music Bot row appears in the members list with the
    // now-playing title.
    await pageB.getByText('Music Bot').waitFor({ timeout: 10000 });
    const botRow = pageB.locator('.member-row--music-bot');
    assert.match(await botRow.textContent(), /Smoke Tone/);

    // Tidy up: Alice (owner) stops the music, freeing the DJ slot
    // before the leave/postcard subtest.
    await pageA.getByRole('button', { name: 'Stop music' }).click();
    await pageA.getByText('No DJ').waitFor({ timeout: 10000 });
    fixture.close();
  });

  await t.test('postcard on leave, other side (Bob leaves the private room)', async () => {
    await pageB.locator('button[aria-label="Leave room"]').click();
    const card = pageB.getByRole('dialog', { name: `Recap of ${PRIVATE_ROOM_NAME}` });
    await card.waitFor({ timeout: 30000 });
    assert.match(await card.textContent(), new RegExp(USERS[0].name),
      "Bob's postcard must name Alice, who he was in the room with");
    await pageB.getByRole('button', { name: 'Dismiss postcard' }).click();
    await card.waitFor({ state: 'detached', timeout: 5000 });
  });

  await t.test('no uncaught page errors on either side', async () => {
    for (const [page, who] of [[pageA, 'Alice'], [pageB, 'Bob']]) {
      assert.deepEqual(page._smokeErrors, [], `${who}'s page must have no uncaught errors`);
      await page.context().close();
    }
  });
});
