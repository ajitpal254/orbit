// Tests for Google ID-token verification (lib/googleAuth.js).
// The verifier is injected, so no network and no Google account are needed.
// DB-backed findOrCreateGoogleUser is NOT covered here (no Mongo in the
// sandbox); the verification logic — the part that talks to Google — is.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyGoogleCredential } = require('../lib/googleAuth');

const payload = {
  sub: 'google-123456',
  email: 'Test@Example.com',
  email_verified: true,
  name: 'Test User',
  picture: 'https://example.com/pic.jpg'
};

const ticketFor = (p) => ({ getPayload: () => p });

test('google verify returns normalized identity for a valid token', async () => {
  const verify = async (idToken) => {
    assert.equal(idToken, 'fake-credential-jwt');
    return ticketFor(payload);
  };
  const identity = await verifyGoogleCredential('fake-credential-jwt', verify);
  assert.deepEqual(identity, {
    googleId: 'google-123456',
    email: 'test@example.com', // lowercased
    name: 'Test User',
    picture: 'https://example.com/pic.jpg'
  });
});

test('google verify tolerates a payload with no name/picture', async () => {
  const verify = async () => ticketFor({ sub: 'g-1', email: 'a@b.co', email_verified: true });
  const identity = await verifyGoogleCredential('cred', verify);
  assert.equal(identity.name, '');
  assert.equal(identity.picture, '');
});

test('google verify refuses an unverified Google email (audit M1/I7)', async () => {
  const verify = async () => ticketFor({ sub: 'g-1', email: 'a@b.co', email_verified: false });
  await assert.rejects(() => verifyGoogleCredential('cred', verify), /not verified/);
});

test('google verify refuses when email_verified is missing', async () => {
  // Only an explicit true proves Google owns the email; an absent
  // claim is not proof.
  const verify = async () => ticketFor({ sub: 'g-1', email: 'a@b.co' });
  await assert.rejects(() => verifyGoogleCredential('cred', verify), /not verified/);
});

test('google verify rejects when the verifier rejects (bad/expired token)', async () => {
  const verify = async () => { throw new Error('Token used too late'); };
  await assert.rejects(() => verifyGoogleCredential('stale-cred', verify), /Token used too late/);
});

test('google verify rejects a payload missing sub', async () => {
  const verify = async () => ticketFor({ email: 'a@b.co', email_verified: true });
  await assert.rejects(() => verifyGoogleCredential('cred', verify), /Invalid Google token payload/);
});

test('google verify rejects a payload missing email', async () => {
  const verify = async () => ticketFor({ sub: 'g-1', email_verified: true });
  await assert.rejects(() => verifyGoogleCredential('cred', verify), /Invalid Google token payload/);
});

test('google verify rejects a missing/empty credential without calling the verifier', async () => {
  let called = false;
  const verify = async () => { called = true; return ticketFor(payload); };
  await assert.rejects(() => verifyGoogleCredential('', verify), /Missing Google credential/);
  await assert.rejects(() => verifyGoogleCredential(undefined, verify), /Missing Google credential/);
  assert.equal(called, false);
});
