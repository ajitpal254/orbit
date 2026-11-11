// Tests for the API helper's CSRF handling (frontend/src/api.js).
// Two cases that used to fail with a bare 403 before the password was
// ever checked: a cold load whose bootstrap token fetch has not landed
// yet, and a stale token. Both must end in a successful call — the helper
// fetches a fresh token and retries once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiJson, getCookie } from '../frontend/src/api.js';

// Fake browser globals: document.cookie storage + a fetch stub playing
// the server. The token endpoint issues a cookie; POSTs require the
// header to equal the currently stored cookie.
let serverCookie = '';
const calls = [];
const fakeRes = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  clone() { return fakeRes(status, body); }
});
globalThis.document = { cookie: '' };
globalThis.fetch = async (url, opts = {}) => {
  calls.push([url, opts]);
  if (url === '/api/auth/csrf-token') {
    serverCookie = `tok-${calls.length}-${Math.random().toString(36).slice(2, 8)}`;
    globalThis.document.cookie = `csrfToken=${serverCookie}`;
    return fakeRes(200, { csrfToken: serverCookie });
  }
  if (url === '/api/config') return fakeRes(200, { googleClientId: null });
  if (url === '/api/forbidden') return fakeRes(403, { error: 'Forbidden' });
  if (url === '/api/rooms/locked-id') {
    return fakeRes(403, { error: 'This room is private', room: { id: 'locked-id', name: 'Late Night', isPrivate: true } });
  }
  if (url === '/api/rooms/locked-id/knock') {
    return fakeRes(429, { error: 'You already knocked — give them a moment before knocking again', knock: { id: 'k1', status: 'pending' } });
  }
  const header = opts.headers?.['x-csrf-token'];
  if (!serverCookie || header !== serverCookie) {
    return fakeRes(403, { error: 'Invalid CSRF token' });
  }
  return fakeRes(200, { user: { id: 'u1' } });
};

function reset() {
  serverCookie = '';
  calls.length = 0;
  globalThis.document.cookie = '';
}

const loginOpts = () => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(12) })
});

test('cold load with no token yet: token is fetched, then login succeeds', async () => {
  reset();
  const data = await apiJson('/api/auth/login', loginOpts());
  assert.deepEqual(data, { user: { id: 'u1' } });
  assert.equal(calls[0][0], '/api/auth/csrf-token');
  assert.equal(calls[1][0], '/api/auth/login');
  assert.equal(calls[1][1].headers['x-csrf-token'], serverCookie);
  assert.equal(getCookie('csrfToken'), serverCookie);
});

test('stale token 403s, then refresh + retry succeeds', async () => {
  reset();
  globalThis.document.cookie = 'csrfToken=stale-old-token';
  serverCookie = 'tok-server-current';
  const data = await apiJson('/api/auth/login', loginOpts());
  assert.deepEqual(data, { user: { id: 'u1' } });
  const logins = calls.filter(([url]) => url === '/api/auth/login');
  assert.equal(logins.length, 2);
  assert.equal(logins[0][1].headers['x-csrf-token'], 'stale-old-token');
  assert.equal(logins[1][1].headers['x-csrf-token'], serverCookie);
  assert.equal(calls.filter(([url]) => url === '/api/auth/csrf-token').length, 1);
});

test('GET requests fetch no token and never retry', async () => {
  reset();
  const data = await apiJson('/api/config');
  assert.deepEqual(data, { googleClientId: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/config');
});

test('a non-CSRF 403 is thrown, not retried', async () => {
  reset();
  await assert.rejects(
    apiJson('/api/forbidden', { method: 'POST' }),
    (err) => err.message === 'Forbidden'
  );
  assert.equal(calls.filter(([url]) => url === '/api/forbidden').length, 1);
});

test('a private-room 403 carries the locked room stub on the error', async () => {
  reset();
  await assert.rejects(
    apiJson('/api/rooms/locked-id'),
    (err) => {
      assert.equal(err.message, 'This room is private');
      assert.equal(err.status, 403);
      assert.deepEqual(err.room, { id: 'locked-id', name: 'Late Night', isPrivate: true });
      return true;
    }
  );
});

test('a rate-limited knock 429 carries the pending knock on the error', async () => {
  reset();
  await assert.rejects(
    apiJson('/api/rooms/locked-id/knock', { method: 'POST' }),
    (err) => {
      assert.equal(err.status, 429);
      assert.deepEqual(err.knock, { id: 'k1', status: 'pending' });
      return true;
    }
  );
});
