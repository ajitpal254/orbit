// Tests for the CORS allow-list (audit L1, lib/cors.js).
// Pure: resolveCorsOrigins takes { env, log } so no process.env is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RENDER_ORIGIN, DEV_ORIGINS, resolveCorsOrigins } = require('../lib/cors');

test('cors: an explicitly set CORS_ORIGIN wins, comma-separated + trimmed', () => {
  const origins = resolveCorsOrigins({
    env: { CORS_ORIGIN: ' https://a.example.com,https://b.example.com , ' }
  });
  assert.deepEqual(origins, ['https://a.example.com', 'https://b.example.com']);
});

test('cors: unset CORS_ORIGIN defaults to the hosted origin + localhost dev origins — never "allow all"', () => {
  const origins = resolveCorsOrigins({ env: {} });
  assert.deepEqual(origins, [RENDER_ORIGIN, ...DEV_ORIGINS]);
  assert.equal(RENDER_ORIGIN, 'https://orbit-3lzs.onrender.com');
  assert.ok(!origins.includes('*'));
  assert.ok(!origins.includes(true));
});

test('cors: unset CORS_ORIGIN in production logs a warning, in dev it stays quiet', () => {
  const logged = [];
  const log = { warn: (msg) => logged.push(msg) };
  resolveCorsOrigins({ env: { NODE_ENV: 'production' }, log });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /CORS_ORIGIN is not set/);
  resolveCorsOrigins({ env: {}, log });
  assert.equal(logged.length, 1, 'no warning outside production');
  resolveCorsOrigins({ env: { NODE_ENV: 'production', CORS_ORIGIN: 'https://x.example.com' }, log });
  assert.equal(logged.length, 1, 'no warning when CORS_ORIGIN is set');
});
