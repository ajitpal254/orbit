// Media sharing: image uploads stored in MongoDB GridFS.
//
// Design (kept consistent with how chat text is stored):
// - Images ONLY (jpeg/png/gif/webp), 10MB cap, validated server-side
//   twice: multer's fileFilter on the declared MIME type, then a magic
//   -byte sniff on the actual buffer (a renamed .exe with an image/*
//   MIME must not get in). No S3, no new external service, no new keys.
// - Files live in the `media` GridFS bucket (media.files /
//   media.chunks). The URL a client gets is /api/media/<fileId> — an
//   unguessable ObjectId, served only to an authenticated user who may
//   see the message it belongs to (see routes/api.js).
// - Fading chat: an upload is provisional until a message claims it.
//   At upload the file gets metadata.expireAt = now + 24h (the same
//   TTL as a message); when a message is created with that media, the
//   file's metadata is re-stamped to the message's own expireAt, so
//   the file expires exactly when its message does. A TTL index on
//   media.files metadata.expireAt (created at boot — see
//   ensureMediaIndexes) cleans up storage, exactly like the TTL index
//   on Message.expireAt; reads enforce expiry immediately, they never
//   wait for the TTL monitor.
// - Filenames are metadata only (alt text): the stored GridFS
//   filename is the file id, never the client-supplied name, so a
//   crafted name cannot smuggle a path or a content type anywhere.
//
// Pure helpers here are unit-testable without MongoDB; the GridFS
// helpers need a live connection (db) and are exercised by the
// DB-gated route tests.

const mongoose = require('mongoose');
const { MESSAGE_TTL_MS } = require('./fadingChat');

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const BUCKET_NAME = 'media';
const MEDIA_URL_PATTERN = /^\/api\/media\/([0-9a-fA-F]{24})$/;

// Magic bytes per format (offset 0, except WebP: "RIFF" + size + "WEBP").
const sniffImageMime = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) {
    return 'image/gif';
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
};

const isAllowedImageMime = (mime) => ALLOWED_MIME_TYPES.includes(mime);

// Multer fileFilter input: the declared MIME type only — the magic-byte
// sniff runs on the buffer afterwards (validateUploadBuffer).
const validateUploadFile = (file) => {
  if (!file) return { ok: false, error: 'No image selected' };
  if (!isAllowedImageMime(file.mimetype)) {
    return { ok: false, error: 'Only images are allowed (JPEG, PNG, GIF, WebP)' };
  }
  if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) {
    return { ok: false, error: 'Image must be 10MB or smaller' };
  }
  return { ok: true };
};

// The buffer itself must be the image its MIME claims — catches a
// renamed executable or a mismatched content type.
const validateUploadBuffer = (buffer, declaredMime) => {
  const sniffed = sniffImageMime(buffer);
  if (!sniffed) return { ok: false, error: 'That file is not a valid image' };
  if (declaredMime && sniffed !== declaredMime) {
    return { ok: false, error: 'That file is not a valid image' };
  }
  return { ok: true, mime: sniffed };
};

// The media field on a message: { url, type, width, height, name }.
// The URL must point at our own media endpoint — a client may never
// smuggle an arbitrary remote URL into a message's media slot (that
// would turn every chat into an open image proxy / tracker beacon).
// Width/height are client-measured (the browser reads them off the
// file before upload); the server only sanity-checks the range — they
// drive display size, never security.
const validateMediaField = (media) => {
  if (media == null) return { ok: true, media: undefined };
  if (typeof media !== 'object' || Array.isArray(media)) {
    return { ok: false, error: 'Invalid image attachment' };
  }
  const match = typeof media.url === 'string' ? media.url.match(MEDIA_URL_PATTERN) : null;
  if (!match) return { ok: false, error: 'Invalid image attachment' };
  if (media.type !== undefined && media.type !== 'image') {
    return { ok: false, error: 'Invalid image attachment' };
  }
  const clean = { url: media.url, type: 'image', fileId: match[1] };
  for (const key of ['width', 'height']) {
    if (media[key] === undefined || media[key] === null) continue;
    const n = Number(media[key]);
    if (!Number.isInteger(n) || n < 1 || n > 20000) {
      return { ok: false, error: 'Invalid image attachment' };
    }
    clean[key] = n;
  }
  if (media.name !== undefined && media.name !== null) {
    if (typeof media.name !== 'string') return { ok: false, error: 'Invalid image attachment' };
    const name = media.name.trim().slice(0, 200);
    if (name) clean.name = name;
  }
  return { ok: true, media: clean };
};

// The GridFS file id behind a media URL, or null.
const fileIdFromMediaUrl = (url) => {
  const match = typeof url === 'string' ? url.match(MEDIA_URL_PATTERN) : null;
  return match ? match[1] : null;
};

const mediaUrlFor = (fileId) => `/api/media/${String(fileId)}`;

// --- GridFS helpers (need a live connection) ---

const getBucket = (db) => {
  const database = db || mongoose.connection.db;
  if (!database) throw new Error('No MongoDB connection for media storage');
  return new mongoose.mongo.GridFSBucket(database, { bucketName: BUCKET_NAME });
};

// TTL index on media.files metadata.expireAt — the storage cleanup
// half of fading chat for uploads (see the module header). Best-effort:
// a failure is logged by the caller, never fatal at boot.
const ensureMediaIndexes = async (db) => {
  const database = db || mongoose.connection.db;
  if (!database) return false;
  await database.collection(`${BUCKET_NAME}.files`).createIndex(
    { 'metadata.expireAt': 1 },
    { expireAfterSeconds: 0, name: 'media_expireAt_ttl' }
  );
  return true;
};

// Store an upload buffer. Provisional expiry (now + 24h) until a
// message claims the file — see linkMediaToMessage.
const storeUpload = ({ buffer, mimetype, originalName, uploaderId, now = new Date() }) =>
  new Promise((resolve, reject) => {
    let bucket;
    try {
      bucket = getBucket();
    } catch (err) {
      return reject(err);
    }
    const fileId = new mongoose.Types.ObjectId();
    const stream = bucket.openUploadStreamWithId(fileId, String(fileId), {
      metadata: {
        uploaderId: String(uploaderId),
        originalName: String(originalName || '').slice(0, 200),
        // The mongodb driver no longer stores a top-level contentType
        // on the GridFS file doc (it is silently dropped), so the MIME
        // lives in metadata — the download endpoint reads it from here.
        contentType: mimetype,
        // Provisional: a message created from this upload re-stamps
        // this to its own expireAt (linkMediaToMessage).
        expireAt: new Date(new Date(now).getTime() + MESSAGE_TTL_MS)
      }
    });
    stream.on('error', reject);
    stream.on('finish', () => resolve({ fileId, url: mediaUrlFor(fileId) }));
    stream.end(buffer);
  });

// Find the media.files doc for an upload, or null.
const mediaFilesCollection = (db) => {
  const database = db || mongoose.connection.db;
  if (!database) throw new Error('No MongoDB connection for media storage');
  return database.collection(`${BUCKET_NAME}.files`);
};

const findMediaFile = async (fileId) => {
  if (!mongoose.Types.ObjectId.isValid(fileId)) return null;
  return mediaFilesCollection().findOne({ _id: new mongoose.Types.ObjectId(fileId) });
};

// Did this user upload this file? Guards the message-create paths:
// a client may only attach their own upload.
const ownsUpload = async (fileId, userId) => {
  const file = await findMediaFile(fileId);
  return !!file && String(file.metadata?.uploaderId) === String(userId);
};

// Claim an upload for a message: re-stamp its expiry to the message's
// own expireAt (so file and message fade together) and record the
// message, so the download endpoint can check who may see it. Fails
// (returns false) when the file is missing or already claimed by
// another message — one upload, one message.
const linkMediaToMessage = async (fileId, { messageId, expireAt }) => {
  if (!mongoose.Types.ObjectId.isValid(fileId)) return false;
  const files = mediaFilesCollection();
  const res = await files.updateOne(
    {
      _id: new mongoose.Types.ObjectId(fileId),
      $or: [
        { 'metadata.messageId': { $exists: false } },
        { 'metadata.messageId': null }
      ]
    },
    {
      $set: {
        'metadata.messageId': new mongoose.Types.ObjectId(messageId),
        'metadata.expireAt': new Date(expireAt)
      }
    }
  );
  return res.matchedCount === 1;
};

// Claim an upload for a new message (room chat + DMs + the socket
// chat-message path all share this): the file must exist, be mine,
// and not already claimed by another message. Returns the sanitized
// media field for storage (the internal fileId stripped) plus the
// fileId for linkMediaToMessage. One upload, one message — sending
// the same image twice means uploading it twice, so an expiry
// re-stamp can never resurrect a file another message already owns.
const claimUploadForMessage = async (media, userId) => {
  if (!media) return { ok: true, media: undefined, fileId: null };
  const fileId = media.fileId;
  const file = await findMediaFile(fileId);
  if (!file || String(file.metadata?.uploaderId) !== String(userId)) {
    return { ok: false, error: 'That image upload was not found — please upload it again' };
  }
  if (file.metadata?.messageId) {
    return { ok: false, error: 'That image was already sent — upload it again to send it twice' };
  }
  const { fileId: _drop, ...stored } = media;
  return { ok: true, media: stored, fileId };
};

module.exports = {
  MAX_FILE_BYTES,
  ALLOWED_MIME_TYPES,
  BUCKET_NAME,
  sniffImageMime,
  isAllowedImageMime,
  validateUploadFile,
  validateUploadBuffer,
  validateMediaField,
  fileIdFromMediaUrl,
  mediaUrlFor,
  getBucket,
  ensureMediaIndexes,
  storeUpload,
  findMediaFile,
  ownsUpload,
  linkMediaToMessage,
  claimUploadForMessage
};
