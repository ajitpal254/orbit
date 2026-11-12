// Tests for media sharing (v0.8.0): the pure helpers in lib/media.js,
// message validation with a media field (lib/rooms.js), the media
// field on the Message / DirectMessage models (offline validate()),
// and the DM summary carrying media through (lib/dms.js).
// No MongoDB needed — GridFS/route behaviour is covered by
// tests/mediaRoutes.test.js (DB-gated).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_FILE_BYTES, sniffImageMime, isAllowedImageMime,
  validateUploadFile, validateUploadBuffer, validateMediaField,
  fileIdFromMediaUrl, mediaUrlFor
} = require('../lib/media');
const { validateMessageInput } = require('../lib/rooms');
const { lastMessageFor } = require('../lib/dms');
const Message = require('../models/Message');
const DirectMessage = require('../models/DirectMessage');

const FILE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MEDIA_URL = `/api/media/${FILE_ID}`;
const GOOD_MEDIA = { url: MEDIA_URL, type: 'image', width: 800, height: 600, name: 'photo.png' };

// Minimal valid headers per format (sniffing only reads the first bytes).
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
const gif87 = Buffer.concat([Buffer.from('GIF87a', 'ascii'), Buffer.alloc(8)]);
const gif89 = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(8)]);
const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(4)]);
const garbage = Buffer.from('MZ this is not an image at all........', 'ascii');

test('sniffImageMime recognizes PNG/JPEG/GIF/WebP and rejects anything else', () => {
  assert.equal(sniffImageMime(png), 'image/png');
  assert.equal(sniffImageMime(jpeg), 'image/jpeg');
  assert.equal(sniffImageMime(gif87), 'image/gif');
  assert.equal(sniffImageMime(gif89), 'image/gif');
  assert.equal(sniffImageMime(webp), 'image/webp');
  assert.equal(sniffImageMime(garbage), null);
  assert.equal(sniffImageMime(Buffer.alloc(4)), null);
  assert.equal(sniffImageMime(null), null);
});

test('validateUploadFile: MIME allowlist + 10MB cap', () => {
  assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
  assert.equal(validateUploadFile({ mimetype: 'image/png', size: 100 }).ok, true);
  assert.equal(validateUploadFile({ mimetype: 'image/webp', size: MAX_FILE_BYTES }).ok, true);
  assert.match(validateUploadFile({ mimetype: 'application/pdf', size: 100 }).error, /Only images/);
  assert.match(validateUploadFile({ mimetype: 'image/png', size: MAX_FILE_BYTES + 1 }).error, /10MB/);
  assert.equal(validateUploadFile(null).ok, false);
  assert.equal(isAllowedImageMime('image/gif'), true);
  assert.equal(isAllowedImageMime('video/mp4'), false);
});

test('validateUploadBuffer: the bytes must be the image the MIME claims', () => {
  assert.deepEqual(validateUploadBuffer(png, 'image/png'), { ok: true, mime: 'image/png' });
  assert.equal(validateUploadBuffer(jpeg, 'image/png').ok, false); // mismatch
  assert.equal(validateUploadBuffer(garbage, 'image/png').ok, false); // renamed .exe
  assert.equal(validateUploadBuffer(garbage, 'application/pdf').ok, false);
});

test('validateMediaField: only our own /api/media URLs, sane dimensions', () => {
  assert.deepEqual(validateMediaField(null), { ok: true, media: undefined });
  assert.deepEqual(validateMediaField(undefined), { ok: true, media: undefined });
  const good = validateMediaField(GOOD_MEDIA);
  assert.equal(good.ok, true);
  assert.equal(good.media.url, MEDIA_URL);
  assert.equal(good.media.fileId, FILE_ID);
  assert.equal(good.media.width, 800);
  assert.equal(good.media.name, 'photo.png');
  // A remote URL must never smuggle into the media slot.
  assert.equal(validateMediaField({ url: 'https://evil.example/x.png', type: 'image' }).ok, false);
  assert.equal(validateMediaField({ url: '/api/media/not-an-objectid', type: 'image' }).ok, false);
  assert.equal(validateMediaField({ url: MEDIA_URL, type: 'video' }).ok, false);
  assert.equal(validateMediaField({ url: MEDIA_URL, width: 0 }).ok, false);
  assert.equal(validateMediaField({ url: MEDIA_URL, width: 99999 }).ok, false);
  assert.equal(validateMediaField({ url: MEDIA_URL, width: 1.5 }).ok, false);
  assert.equal(validateMediaField({ url: MEDIA_URL, name: 42 }).ok, false);
  assert.equal(validateMediaField('nope').ok, false);
  assert.equal(validateMediaField([]).ok, false);
  // Dimensions and name are optional.
  const minimal = validateMediaField({ url: MEDIA_URL });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.media.type, 'image');
  assert.equal(minimal.media.width, undefined);
});

test('fileIdFromMediaUrl / mediaUrlFor round-trip', () => {
  assert.equal(fileIdFromMediaUrl(MEDIA_URL), FILE_ID);
  assert.equal(fileIdFromMediaUrl('https://example.com/x.png'), null);
  assert.equal(fileIdFromMediaUrl(null), null);
  assert.equal(mediaUrlFor(FILE_ID), MEDIA_URL);
});

test('validateMessageInput: text OR image, never neither, never a bad image', () => {
  assert.equal(validateMessageInput({ text: 'hi' }).ok, true);
  assert.equal(validateMessageInput({ text: 'hi' }).media, undefined);
  const mediaOnly = validateMessageInput({ text: '   ', media: GOOD_MEDIA });
  assert.equal(mediaOnly.ok, true);
  assert.equal(mediaOnly.text, '');
  assert.equal(mediaOnly.media.url, MEDIA_URL);
  assert.equal(validateMessageInput({ text: 'hi', media: GOOD_MEDIA }).ok, true);
  assert.equal(validateMessageInput({}).ok, false);
  assert.equal(validateMessageInput({ text: '   ' }).ok, false);
  assert.equal(validateMessageInput({ text: 'x'.repeat(1001) }).ok, false);
  assert.match(
    validateMessageInput({ media: { url: 'https://evil.example/x.png' } }).error,
    /Invalid image/
  );
});

test('Message model accepts a media field and rejects a bad one', () => {
  const base = { roomId: FILE_ID, userId: FILE_ID, name: 'A', text: 'iv:tag:ct' };
  assert.equal(new Message({ ...base, media: GOOD_MEDIA }).validateSync(), undefined);
  assert.equal(new Message({ ...base }).validateSync(), undefined);
  const badType = new Message({ ...base, media: { url: MEDIA_URL, type: 'video' } }).validateSync();
  assert.ok(badType && badType.errors['media.type'], 'video type must fail validation');
  const badWidth = new Message({ ...base, media: { url: MEDIA_URL, width: 0 } }).validateSync();
  assert.ok(badWidth && badWidth.errors['media.width'], 'width 0 must fail validation');
  const badUrl = new Message({ ...base, media: { url: 'x'.repeat(501) } }).validateSync();
  assert.ok(badUrl && badUrl.errors['media.url'], 'overlong URL must fail validation');
});

test('DirectMessage model accepts a media field and rejects a bad one', () => {
  const base = { sender: FILE_ID, recipient: FILE_ID, text: 'iv:tag:ct' };
  assert.equal(new DirectMessage({ ...base, media: GOOD_MEDIA }).validateSync(), undefined);
  const badType = new DirectMessage({ ...base, media: { url: MEDIA_URL, type: 'video' } }).validateSync();
  assert.ok(badType && badType.errors['media.type'], 'video type must fail validation');
});

test('lastMessageFor carries media so the DM list can show "Photo"', () => {
  const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const THEM = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const withMedia = {
    sender: THEM, recipient: ME, text: '', read: false,
    media: { url: MEDIA_URL, type: 'image' },
    createdAt: new Date('2026-11-12T00:00:00Z')
  };
  const last = lastMessageFor([withMedia], ME, THEM);
  assert.equal(last.text, '');
  assert.equal(last.media.url, MEDIA_URL);
  assert.equal(last.fromMe, false);
  const plain = lastMessageFor([{ sender: ME, recipient: THEM, text: 'hi', read: true, createdAt: new Date() }], ME, THEM);
  assert.equal(plain.media, null);
});
