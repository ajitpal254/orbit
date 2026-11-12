// Tests for audit M6: security headers (explicit middleware, no helmet).
// The middleware is tested directly (fake req/res) and integrated —
// mounted in front of the real API router and static serving, every
// response must carry all five headers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, securityHeaders } = require('../middleware/securityHeaders');
const apiRoutes = require('../routes/api');

const EXPECTED = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

test('securityHeaders sets all five headers on the response', () => {
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name] = value; } };
  let nextCalled = false;
  securityHeaders({}, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  for (const [name, value] of Object.entries(EXPECTED)) {
    assert.equal(headers[name], value, name);
  }
  assert.equal(headers['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
});

test('CSP: self + Google GSI script + ws/wss, frame-ancestors none', () => {
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self' ws: wss: https:\/\/accounts\.google\.com/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-src https:\/\/accounts\.google\.com/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /img-src 'self' data:/);
  // GA4 (v0.7.0): ONLY these three additions — gtag.js script host,
  // analytics beacons (connect + img). Nothing else loosened: no new
  // frame-src, no unsafe-inline/eval for scripts, default-src still self.
  assert.match(CONTENT_SECURITY_POLICY, /script-src [^;]*https:\/\/www\.googletagmanager\.com/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src [^;]*https:\/\/www\.google-analytics\.com/);
  assert.match(CONTENT_SECURITY_POLICY, /img-src [^;]*https:\/\/www\.google-analytics\.com/);
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'self'/);
  assert.equal(CONTENT_SECURITY_POLICY.includes('googletagmanager.com/gtag'), false);
  assert.equal(CONTENT_SECURITY_POLICY.includes('google-analytics.com/g/'), false);
  // style-src 'unsafe-inline' is deliberate, not an oversight: the
  // splash <style> block in index.html and React's inline style
  // attributes (orb positions, gradients) cannot work without it.
  assert.match(CONTENT_SECURITY_POLICY, /style-src 'self' 'unsafe-inline'/);
  // No 'unsafe-inline' / 'unsafe-eval' for scripts: there is no inline
  // script anywhere in the built app.
  const scriptSrc = CONTENT_SECURITY_POLICY.match(/script-src ([^;]+)/)[1];
  assert.equal(scriptSrc.includes('unsafe-inline'), false);
  assert.equal(scriptSrc.includes('unsafe-eval'), false);
});

test('SECURITY_HEADERS export matches the middleware output', () => {
  assert.deepEqual(Object.keys(SECURITY_HEADERS).sort(), [
    'Content-Security-Policy',
    'Referrer-Policy',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options'
  ]);
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('headers are present on API, static, SPA, and 404 responses', async () => {
  const app = express();
  app.use(securityHeaders);
  app.use('/api', apiRoutes);
  // Same shape as server.js: unknown /api paths get a JSON 404 (not
  // Express's bare finalhandler response, which overwrites the CSP
  // with its own "default-src 'none'"); anything else serves the SPA.
  app.use('/api', (req, res) => { res.status(404).json({ error: 'Not found' }); });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/*splat', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const urls = [`${base}/api/config`, `${base}/`, `${base}/no-such-page`, `${base}/api/nope`];
    for (const url of urls) {
      const res = await fetch(url);
      for (const [name, value] of Object.entries(EXPECTED)) {
        assert.equal(res.headers.get(name.toLowerCase()), value, `${url} ${name}`);
      }
      assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, url);
    }
    const api404 = await fetch(`${base}/api/nope`);
    assert.equal(api404.status, 404);
    assert.deepEqual(await api404.json(), { error: 'Not found' });
  } finally {
    server.close();
  }
});
