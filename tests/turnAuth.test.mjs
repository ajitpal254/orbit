// Tests for frontend/src/turnAuth.js: the time-limited static-auth TURN
// credential (coturn static auth) and the ICE server assembly. The
// credential construction is checked against Node's independent HMAC
// implementation, so a wrong key/encoding breaks the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  computeTurnCredential,
  staticAuthUsername,
  getStaticAuthServers,
  getAccountTurn,
  getIceServers
} from '../frontend/src/turnAuth.js';

test('computeTurnCredential matches HMAC-SHA1(secret, username) base64', async () => {
  const username = '1794364800:openrelayproject';
  const secret = 'openrelayprojectsecret';
  const expected = createHmac('sha1', secret).update(username).digest('base64');
  assert.equal(await computeTurnCredential(username, secret), expected);
});

test('staticAuthUsername is a future expiry timestamp plus the label', () => {
  const now = Math.floor(Date.now() / 1000);
  const [ts, label] = staticAuthUsername(now).split(':');
  assert.equal(label, 'openrelayproject');
  assert.ok(Number(ts) > now + 80000 && Number(ts) <= now + 86400);
});

test('getStaticAuthServers returns staticauth TURN on 80/443 + TCP 443', async () => {
  const servers = await getStaticAuthServers();
  assert.equal(servers.length, 3);
  const urls = servers.map((s) => s.urls);
  assert.ok(urls.includes('turn:staticauth.openrelay.metered.ca:80'));
  assert.ok(urls.includes('turn:staticauth.openrelay.metered.ca:443'));
  assert.ok(urls.includes('turn:staticauth.openrelay.metered.ca:443?transport=tcp'));
  // All three share one time-limited username/credential; the credential
  // is base64 of a 20-byte HMAC-SHA1 (28 chars with one '=' pad).
  assert.match(servers[0].username, /^\d+:openrelayproject$/);
  assert.ok(servers.every((s) => s.username === servers[0].username));
  assert.ok(servers.every((s) => s.credential === servers[0].credential));
  assert.equal(servers[0].credential.length, 28);
});

test('getIceServers puts account TURN first, then static-auth, then freeturn, then STUN', async () => {
  const account = { urls: ['turn:standard.relay.metered.ca:80'], username: 'u1', credential: 'p1' };
  const servers = await getIceServers(account);
  assert.deepEqual(servers[0], account);
  assert.ok(servers.some((s) => String(s.urls).includes('staticauth.openrelay.metered.ca')));
  assert.ok(servers.some((s) => s.urls === 'turn:freeturn.net:3478' && s.username === 'free'));
  assert.ok(servers.some((s) => s.urls === 'turns:freeturn.net:5349'));
  assert.ok(servers.some((s) => JSON.stringify(s.urls).includes('stun.l.google.com')));
  const noAccount = await getIceServers(null);
  assert.ok(!noAccount.some((s) => s.username === 'u1'));
  assert.ok(noAccount.some((s) => String(s.urls).includes('staticauth.openrelay.metered.ca')));
});

// Audit H2 client seam: /api/config no longer carries TURN credentials,
// so getIceServers fetches the minted credential from GET /api/turn
// whenever the object it was handed has URLs but no credential.
// voice.js is untouched — this is the seam it already calls.
const realFetch = globalThis.fetch;

test('getAccountTurn returns the minted credential, null on any failure', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const minted = { urls: ['turn:standard.relay.metered.ca:80'], username: '1794364800:aaaa', credential: 'AAAA' };
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, '/api/turn');
    assert.equal(opts.credentials, 'include');
    return { ok: true, json: async () => ({ turn: minted }) };
  };
  assert.deepEqual(await getAccountTurn(), minted);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await getAccountTurn(), null);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ turn: null }) });
  assert.equal(await getAccountTurn(), null);
  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.equal(await getAccountTurn(), null);
});

test('getIceServers with a urls-only object fetches /api/turn for the credential', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const minted = { urls: ['turn:standard.relay.metered.ca:443'], username: '1794364800:aaaa', credential: 'BBBB' };
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    return { ok: true, json: async () => ({ turn: minted }) };
  };
  const servers = await getIceServers({ urls: ['turn:standard.relay.metered.ca:443'] });
  assert.equal(fetched, 1);
  assert.deepEqual(servers[0], minted);
  // An object that already carries a credential is used as-is, no fetch.
  fetched = 0;
  const direct = { urls: ['turn:x.test:3478'], username: 'u1', credential: 'p1' };
  assert.deepEqual((await getIceServers(direct))[0], direct);
  assert.equal(fetched, 0);
});
