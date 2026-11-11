// Tests for audit M2: the invite-link token travels in the JSON POST
// body, never in the URL path — and never in the server logs.
//
// The old POST /api/invite-links/:token/join route is gone; joining
// uses POST /api/invite-links/join { token }. Request logs carry the
// route pattern (or a scrubbed path), and the pino redact list covers
// token fields as a backstop.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Writable } = require('node:stream');
const { generateInviteToken } = require('../lib/inviteLinks');
const { requestPath, scrubPath, requestLog } = require('../middleware/requestLog');
const { createLogger } = require('../lib/logger');
const apiRoutes = require('../routes/api');

const TOKEN = generateInviteToken();

// --- Route shape (real router, no MongoDB: auth refuses before any DB
// call when there is no session cookie, and a missing route 404s). ---

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('new body route exists: POST /api/invite-links/join without auth is 401, not 404', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  const server = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/invite-links/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN })
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('old path-token route is gone: POST /api/invite-links/<token>/join is 404', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  const server = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/invite-links/${TOKEN}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

// --- requestPath / scrubPath units ---

test('requestPath returns the matched route pattern, never the raw URL', () => {
  const req = {
    baseUrl: '/api',
    route: { path: '/invite-links/join' },
    originalUrl: '/api/invite-links/join'
  };
  assert.equal(requestPath(req), '/api/invite-links/join');
});

test('scrubPath drops query strings and replaces token-shaped segments', () => {
  assert.equal(
    scrubPath(`/api/invite-links/${TOKEN}/join?x=1`),
    '/api/invite-links/:token/join'
  );
  assert.equal(scrubPath('/api/rooms/abc?foo=bar'), '/api/rooms/abc');
  assert.equal(scrubPath('/api/config'), '/api/config');
  assert.equal(scrubPath(''), '');
});

test('requestPath falls back to the scrubbed path when no route matched', () => {
  const req = { baseUrl: '', route: undefined, originalUrl: `/api/invite-links/${TOKEN}/join` };
  assert.equal(requestPath(req), '/api/invite-links/:token/join');
  assert.equal(requestPath(req).includes(TOKEN), false);
});

// --- The actual log line for a join contains no token ---

function memoryLogger() {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) { buf += String(chunk); cb(); }
  });
  return { logger: createLogger(stream), text: () => buf };
}

const waitFor = async (fn, timeoutMs = 2000) => {
  const start = Date.now();
  for (;;) {
    try { return fn(); } catch {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for log line');
      await new Promise((r) => setTimeout(r, 25));
    }
  }
};

test('request log line for a body-token join contains the route, not the token', async () => {
  const mem = memoryLogger();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = mem.logger; next(); });
  app.use(requestLog);
  app.post('/api/invite-links/join', (_req, res) => res.json({ ok: true }));
  const server = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/invite-links/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN })
    });
    assert.equal(res.status, 200);
    const line = await waitFor(() => {
      const hit = mem.text().split('\n').find((l) => l.includes('invite-links'));
      assert.ok(hit, 'no log line yet');
      return hit;
    });
    assert.ok(line.includes('/api/invite-links/join'));
    assert.equal(line.includes(TOKEN), false, 'log line leaked the invite token');
  } finally {
    server.close();
  }
});

test('request log line for a legacy path-token URL is scrubbed, even on 404', async () => {
  const mem = memoryLogger();
  const app = express();
  app.use((req, _res, next) => { req.log = mem.logger; next(); });
  app.use(requestLog);
  const server = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/invite-links/${TOKEN}/join`, {
      method: 'POST'
    });
    assert.equal(res.status, 404);
    const line = await waitFor(() => {
      const hit = mem.text().split('\n').find((l) => l.includes('invite-links'));
      assert.ok(hit, 'no log line yet');
      return hit;
    });
    assert.ok(line.includes('/api/invite-links/:token/join'));
    assert.equal(line.includes(TOKEN), false, 'log line leaked the invite token');
  } finally {
    server.close();
  }
});

// --- Pino redact backstop (audit I4) ---

test('logger redacts token / credential / sessionToken / csrfToken fields', async () => {
  const mem = memoryLogger();
  mem.logger.info(
    { token: 'tok-secret', credential: 'cred-secret', sessionToken: 'sess-secret', csrfToken: 'csrf-secret', other: 'keep-me' },
    'probe'
  );
  const line = await waitFor(() => {
    assert.ok(mem.text().includes('probe'), 'no log line yet');
    return mem.text();
  });
  for (const secret of ['tok-secret', 'cred-secret', 'sess-secret', 'csrf-secret']) {
    assert.equal(line.includes(secret), false, `log leaked ${secret}`);
  }
  assert.ok(line.includes('[REDACTED]'));
  assert.ok(line.includes('keep-me'));
});
