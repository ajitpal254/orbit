// Tests for the double-submit CSRF middleware (middleware/auth.js).
// The middleware is a plain (req, res, next) function, so it is tested
// directly with fake req/res objects — no Express or DB needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { csrfMiddleware } = require('../middleware/auth');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function runMiddleware({ cookie, header }) {
  const req = {
    method: 'POST',
    headers: {
      cookie: cookie ? `csrfToken=${cookie}` : '',
      'x-csrf-token': header
    }
  };
  const res = fakeRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('matching cookie and header pass through', () => {
  const { res, nextCalled } = runMiddleware({ cookie: 'tok-123', header: 'tok-123' });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('missing cookie or header -> 403 Invalid CSRF token', () => {
  for (const args of [
    { cookie: null, header: 'tok-123' },
    { cookie: 'tok-123', header: undefined },
    { cookie: 'tok-123', header: '' }
  ]) {
    const { res, nextCalled } = runMiddleware(args);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'Invalid CSRF token');
  }
});

test('mismatched values -> 403 Invalid CSRF token', () => {
  const { res, nextCalled } = runMiddleware({ cookie: 'tok-aaa', header: 'tok-bbb' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Invalid CSRF token');
});

test('different-length cookie and header -> 403, not a throw', () => {
  // timingSafeEqual throws on unequal lengths; the guard must turn that
  // into a clean 403 instead of a 500.
  const { res, nextCalled } = runMiddleware({ cookie: 'short', header: 'a-much-longer-token-value' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Invalid CSRF token');
});

test('GET requests skip the check entirely', () => {
  const req = { method: 'GET', headers: {} };
  const res = fakeRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('leave-beacon POST skips the check (sendBeacon sends no custom headers)', () => {
  // v0.9.0: the pagehide beacon cannot carry x-csrf-token. Its only
  // effect is self-departure and authMiddleware still runs after it,
  // so the exemption is narrow. Without the session cookie there is
  // still no token to check — the exemption is about the header, not
  // the auth — so both cases pass the middleware.
  for (const path of ['/rooms/aaaaaaaaaaaaaaaaaaaaaaaa/leave-beacon']) {
    const req = { method: 'POST', path, headers: {} };
    const res = fakeRes();
    let nextCalled = false;
    csrfMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, path + ' should pass the middleware');
    assert.equal(res.statusCode, null);
  }
});

test('leave-beacon exemption is exact: other room POSTs still need the token', () => {
  for (const path of [
    '/rooms/aaaaaaaaaaaaaaaaaaaaaaaa/leave-beacon/extra',
    '/rooms/aaaaaaaaaaaaaaaaaaaaaaaa/messages',
    '/rooms/leave-beacon'
  ]) {
    const req = { method: 'POST', path, headers: {} };
    const res = fakeRes();
    let nextCalled = false;
    csrfMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false, path + ' must NOT be exempt');
    assert.equal(res.statusCode, 403);
  }
});
