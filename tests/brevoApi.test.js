// Tests for the Brevo HTTP API email path (lib/brevoApi.js).
//
// Pure tests — no Mongo needed: the channel picker and the API sender
// are exercised with a stubbed fetch. The wiring into
// sendVerificationEmail lives in tests/emailVerification.test.js.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  BREVO_API_URL,
  isBrevoApiConfigured,
  pickEmailChannel,
  sendViaBrevoApi
} = require('../lib/brevoApi');

const ENV_KEYS = ['BREVO_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
let savedEnv = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test('pickEmailChannel: Brevo API wins when its key is set, even with SMTP too', () => {
  process.env.BREVO_API_KEY = 'xkeysib-test';
  process.env.SMTP_HOST = 'smtp-relay.brevo.com';
  process.env.SMTP_USER = 'u@smtp-brevo.com';
  process.env.SMTP_PASS = 'secret';
  assert.equal(isBrevoApiConfigured(), true);
  assert.equal(pickEmailChannel({ smtpConfigured: true }), 'brevo-api');
});

test('pickEmailChannel: SMTP when only SMTP is configured; none when neither is', () => {
  assert.equal(pickEmailChannel({ smtpConfigured: true }), 'smtp');
  assert.equal(pickEmailChannel({ smtpConfigured: false }), 'none');
});

test('sendViaBrevoApi: posts the right payload and reports sent on 201', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  process.env.SMTP_FROM = 'orbit@example.com';
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 201, json: async () => ({ messageId: 'abc123' }) };
  };
  const result = await sendViaBrevoApi(
    { to: 'a@example.com', subject: 'Verify', text: 'hi', html: '<p>hi</p>' },
    { fetchImpl }
  );
  assert.deepEqual(result, { sent: true });
  assert.equal(seen.url, BREVO_API_URL);
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['api-key'], 'xkeysib-test-key');
  assert.equal(seen.opts.headers['Content-Type'], 'application/json');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.sender.email, 'orbit@example.com');
  assert.deepEqual(body.to, [{ email: 'a@example.com' }]);
  assert.equal(body.subject, 'Verify');
  assert.equal(body.textContent, 'hi');
  assert.equal(body.htmlContent, '<p>hi</p>');
});

test('sendViaBrevoApi: sender falls back to SMTP_USER when SMTP_FROM is unset', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  process.env.SMTP_USER = 'login@smtp-brevo.com';
  let seenBody = null;
  const fetchImpl = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return { ok: true, status: 201, json: async () => ({}) };
  };
  const result = await sendViaBrevoApi(
    { to: 'a@example.com', subject: 's', text: 't' },
    { fetchImpl }
  );
  assert.deepEqual(result, { sent: true });
  assert.equal(seenBody.sender.email, 'login@smtp-brevo.com');
});

test('sendViaBrevoApi: a display name in SMTP_FROM is stripped to the bare address', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  process.env.SMTP_FROM = 'Orbit <orbit@example.com>';
  let seenBody = null;
  const fetchImpl = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return { ok: true, status: 201, json: async () => ({}) };
  };
  const result = await sendViaBrevoApi(
    { to: 'a@example.com', subject: 's', text: 't' },
    { fetchImpl }
  );
  assert.deepEqual(result, { sent: true });
  assert.equal(seenBody.sender.email, 'orbit@example.com');
});

test('sendViaBrevoApi: API rejection fails closed without throwing', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ message: 'sender not validated', code: 'invalid_parameter' })
  });
  const result = await sendViaBrevoApi(
    { to: 'a@example.com', subject: 's', text: 't' },
    { fetchImpl }
  );
  assert.deepEqual(result, { sent: false, reason: 'brevo-api-rejected' });
});

test('sendViaBrevoApi: a hung request aborts at the timeout and fails closed', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
  const result = await sendViaBrevoApi(
    { to: 'a@example.com', subject: 's', text: 't' },
    { fetchImpl, timeoutMs: 50 }
  );
  assert.deepEqual(result, { sent: false, reason: 'brevo-api-failed' });
});

test('sendViaBrevoApi: no API key fails closed without calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 201, json: async () => ({}) };
  };
  const result = await sendViaBrevoApi(
    { to: 'a@example.com', subject: 's', text: 't' },
    { fetchImpl }
  );
  assert.deepEqual(result, { sent: false, reason: 'brevo-api-not-configured' });
  assert.equal(called, false);
});
