// Tests for profile validation + serialization (lib/profile.js).
// Pure logic, no Mongo: validateProfileUpdate and profileJson only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_NAME_LENGTH, MAX_BIO_LENGTH, MAX_AVATAR_IMAGE_LENGTH,
  isValidAvatarImage, validateProfileUpdate, profileJson
} = require('../lib/profile');

const smallJpeg = 'data:image/jpeg;base64,' + 'a'.repeat(100);
const smallPng = 'data:image/png;base64,' + 'a'.repeat(100);
const smallWebp = 'data:image/webp;base64,' + 'a'.repeat(100);

test('valid updates pass through sanitized', () => {
  const r = validateProfileUpdate({
    name: '  Ajit Pal  ', bio: '  hello  ', avatarPreset: 'nova', avatarImage: ''
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.updates, {
    name: 'Ajit Pal', bio: 'hello', avatarPreset: 'nova', avatarImage: ''
  });
});

test('empty body is a 400, unknown fields are ignored', () => {
  assert.equal(validateProfileUpdate({}).ok, false);
  assert.equal(validateProfileUpdate({}).error, 'Nothing to update');
  const r = validateProfileUpdate({ name: 'Ajit', passwordHash: 'x', email: 'a@b.c' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.updates, { name: 'Ajit' });
});

test('name must be present and within the limit', () => {
  assert.equal(validateProfileUpdate({ name: '' }).ok, false);
  assert.equal(validateProfileUpdate({ name: '   ' }).ok, false);
  assert.equal(validateProfileUpdate({ name: 'x'.repeat(MAX_NAME_LENGTH + 1) }).ok, false);
  assert.equal(validateProfileUpdate({ name: 'x'.repeat(MAX_NAME_LENGTH) }).ok, true);
  assert.equal(validateProfileUpdate({ name: 42 }).ok, false);
});

test('bio is capped at 140 characters', () => {
  assert.equal(validateProfileUpdate({ bio: 'x'.repeat(MAX_BIO_LENGTH + 1) }).ok, false);
  assert.equal(validateProfileUpdate({ bio: 'x'.repeat(MAX_BIO_LENGTH) }).ok, true);
  assert.equal(validateProfileUpdate({ bio: '' }).ok, true);
});

test('avatarPreset must be a known id or null', () => {
  assert.equal(validateProfileUpdate({ avatarPreset: 'nova' }).ok, true);
  assert.equal(validateProfileUpdate({ avatarPreset: null }).ok, true);
  const bad = validateProfileUpdate({ avatarPreset: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'Unknown avatar preset');
  assert.equal(validateProfileUpdate({ avatarPreset: 42 }).ok, false);
});

test('avatarImage must be a small PNG/JPEG/WebP data URL', () => {
  assert.equal(isValidAvatarImage(smallJpeg), true);
  assert.equal(isValidAvatarImage(smallPng), true);
  assert.equal(isValidAvatarImage(smallWebp), true);
  assert.equal(isValidAvatarImage(''), false);
  assert.equal(isValidAvatarImage('data:image/gif;base64,aaaa'), false);
  assert.equal(isValidAvatarImage('https://example.com/a.jpg'), false);
  assert.equal(isValidAvatarImage('data:image/jpeg;base64,not base64!!!'), false);
  const big = 'data:image/jpeg;base64,' + 'a'.repeat(MAX_AVATAR_IMAGE_LENGTH);
  assert.equal(isValidAvatarImage(big), false);
  assert.equal(validateProfileUpdate({ avatarImage: '' }).ok, true);
  assert.equal(validateProfileUpdate({ avatarImage: smallJpeg }).ok, true);
  assert.equal(validateProfileUpdate({ avatarImage: big }).ok, false);
});

test('profileJson shapes the public profile', () => {
  const u = {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Ajit', email: 'a@b.c',
    bio: 'hi', avatarPreset: 'tide', avatarImage: smallPng
  };
  assert.deepEqual(profileJson(u), {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Ajit', email: 'a@b.c',
    bio: 'hi', avatarPreset: 'tide', avatarImage: smallPng
  });
  // Missing fields degrade to empty defaults, never undefined.
  assert.deepEqual(
    profileJson({ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: '', email: 'x@y.z' }),
    { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: '', email: 'x@y.z', bio: '', avatarPreset: null, avatarImage: '' }
  );
});
