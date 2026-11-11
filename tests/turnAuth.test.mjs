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

test('getIceServers puts account TURN first, then static-auth, then STUN', async () => {
  const account = { urls: ['turn:standard.relay.metered.ca:80'], username: 'u1', credential: 'p1' };
  const servers = await getIceServers(account);
  assert.deepEqual(servers[0], account);
  assert.ok(servers.some((s) => String(s.urls).includes('staticauth.openrelay.metered.ca')));
  assert.ok(servers.some((s) => JSON.stringify(s.urls).includes('stun.l.google.com')));
  const noAccount = await getIceServers(null);
  assert.ok(!noAccount.some((s) => s.username === 'u1'));
  assert.ok(noAccount.some((s) => String(s.urls).includes('staticauth.openrelay.metered.ca')));
});
