// Tests for the GA4 runtime config on GET /api/config
// (routes/api.js): GA_MEASUREMENT_ID is served only when set and valid,
// and the field is omitted entirely when unset — the client then stays
// a complete no-op. Live-router checks, no MongoDB needed.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const apiRoutes = require('../routes/api');

const savedEnv = { GA_MEASUREMENT_ID: process.env.GA_MEASUREMENT_ID };
afterEach(() => {
  if (savedEnv.GA_MEASUREMENT_ID === undefined) delete process.env.GA_MEASUREMENT_ID;
  else process.env.GA_MEASUREMENT_ID = savedEnv.GA_MEASUREMENT_ID;
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const base = (server) => `http://127.0.0.1:${server.address().port}`;

const getConfig = async () => {
  const app = express();
  app.use('/api', apiRoutes);
  const server = await listen(app);
  try {
    const res = await fetch(`${base(server)}/api/config`);
    assert.equal(res.status, 200);
    return res.json();
  } finally {
    server.close();
  }
};

test('GET /api/config omits gaMeasurementId entirely when GA_MEASUREMENT_ID is unset', async () => {
  delete process.env.GA_MEASUREMENT_ID;
  const body = await getConfig();
  assert.equal('gaMeasurementId' in body, false);
  assert.equal(JSON.stringify(body).includes('G-'), false);
});

test('GET /api/config returns the ID when GA_MEASUREMENT_ID is set', async () => {
  process.env.GA_MEASUREMENT_ID = 'G-ABC12345';
  const body = await getConfig();
  assert.equal(body.gaMeasurementId, 'G-ABC12345');
});

test('GET /api/config normalises a lowercase ID and omits a malformed one', async () => {
  process.env.GA_MEASUREMENT_ID = '  g-abc12345  ';
  assert.equal((await getConfig()).gaMeasurementId, 'G-ABC12345');
  process.env.GA_MEASUREMENT_ID = 'UA-12345-1';
  assert.equal('gaMeasurementId' in (await getConfig()), false);
  process.env.GA_MEASUREMENT_ID = 'not-an-id';
  assert.equal('gaMeasurementId' in (await getConfig()), false);
});
