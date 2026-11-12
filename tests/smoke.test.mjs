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
  return page;
}

test('smoke: two users join a room and voice starts', { timeout: 180000 }, async (t) => {
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

  await t.test('Alice creates a room, Bob joins it', async () => {
    await pageA.getByRole('button', { name: 'New room' }).click();
    await pageA.getByPlaceholder(/Room name/).fill(ROOM_NAME);
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
        const m = cur.match(/(\S+) \/ (\S+) \(([^)]*)\)/);
        if (!m || m[1] === '—' || m[1] === 'new') return false;
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

  await t.test('no uncaught page errors on either side', async () => {
    for (const [page, who] of [[pageA, 'Alice'], [pageB, 'Bob']]) {
      assert.deepEqual(page._smokeErrors, [], `${who}'s page must have no uncaught errors`);
      await page.context().close();
    }
  });
});
