// Profile validation + serialization. Pure logic, no DB access, so it
// is unit-testable without MongoDB (see tests/profile.test.js).
//
// Bio and avatar are PUBLIC profile data — shown to friends and room
// members — so they are not encrypted (unlike chat/DM text). Avatar
// images are user-uploaded photos downscaled client-side to 256px JPEG
// before sending; the server still enforces the data-URL shape and the
// size cap so a hand-rolled client cannot stuff a huge blob into the
// user document.
const { isValidAvatarPreset } = require('./avatars');
const { isValidMood, normalizeMood } = require('./mood');

const MAX_NAME_LENGTH = 40;
const MAX_BIO_LENGTH = 140;
// A 256x256 JPEG at quality ~0.8 is usually 10–30KB; 200KB is a generous
// cap that still keeps the user document (and every friends-list fetch
// carrying avatars) small.
const MAX_AVATAR_IMAGE_LENGTH = 200 * 1024;

const AVATAR_IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const isValidAvatarImage = (v) =>
  typeof v === 'string' && v.length <= MAX_AVATAR_IMAGE_LENGTH && AVATAR_IMAGE_RE.test(v);

// Validate a PATCH /api/users/me body. Only the fields the client is
// allowed to change are read; anything else is ignored. Returns
// { ok, error?, updates? } — updates holds the sanitized fields to $set.
const validateProfileUpdate = (body = {}) => {
  const updates = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { ok: false, error: 'Name cannot be empty' };
    if (name.length > MAX_NAME_LENGTH) {
      return { ok: false, error: `Name too long (max ${MAX_NAME_LENGTH})` };
    }
    updates.name = name.slice(0, MAX_NAME_LENGTH);
  }
  if (body.bio !== undefined) {
    const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
    if (bio.length > MAX_BIO_LENGTH) {
      return { ok: false, error: `Bio too long (max ${MAX_BIO_LENGTH})` };
    }
    updates.bio = bio.slice(0, MAX_BIO_LENGTH);
  }
  if (body.avatarPreset !== undefined) {
    // null clears the preset (back to initials); a string must be a
    // known preset id. Anything else is a 400, not a silent ignore —
    // a typo'd preset id should fail loudly, not vanish.
    if (body.avatarPreset !== null && !isValidAvatarPreset(body.avatarPreset)) {
      return { ok: false, error: 'Unknown avatar preset' };
    }
    updates.avatarPreset = body.avatarPreset;
  }
  if (body.avatarImage !== undefined) {
    // '' clears a photo; otherwise a data URL within the size cap.
    if (body.avatarImage !== '' && !isValidAvatarImage(body.avatarImage)) {
      return { ok: false, error: 'Avatar image must be a PNG, JPEG or WebP data URL under 200KB' };
    }
    updates.avatarImage = body.avatarImage;
  }
  if (body.mood !== undefined) {
    // Mood glow (v0.7.0): one of the three states in lib/mood.js.
    // An unknown value is a 400, not a silent ignore — same rule as
    // a typo'd avatar preset.
    if (!isValidMood(body.mood)) {
      return { ok: false, error: 'Unknown mood' };
    }
    updates.mood = body.mood;
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: 'Nothing to update' };
  }
  return { ok: true, updates };
};

// The public profile shape sent to the client: own profile (me / PATCH
// response) and the avatar fields other users see (userJson in
// routes/api.js carries the same three fields). emailVerified is
// included so the client can show the "verify your email" prompt and
// the resend action; grandfathered accounts (no field) read as true.
const { isEmailVerified } = require('./emailVerification');

const profileJson = (u) => ({
  id: String(u._id),
  name: u.name || '',
  email: u.email,
  bio: u.bio || '',
  avatarPreset: u.avatarPreset || null,
  avatarImage: u.avatarImage || '',
  mood: normalizeMood(u.mood),
  emailVerified: isEmailVerified(u)
});

module.exports = {
  MAX_NAME_LENGTH, MAX_BIO_LENGTH, MAX_AVATAR_IMAGE_LENGTH,
  isValidAvatarImage, validateProfileUpdate, profileJson
};
