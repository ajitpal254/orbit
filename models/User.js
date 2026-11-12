const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: [120, 'Email too long']
  },
  name: { type: String, trim: true, maxlength: [60, 'Name too long'], default: '' },
  // Public profile (see lib/profile.js): a short bio and an avatar.
  // The avatar is either one of the animated gradient presets
  // (avatarPreset, see lib/avatars.js) or a user-uploaded photo stored
  // as a small data URL (avatarImage, client-downscaled to 256px and
  // capped at 200KB by validation). Both are public profile data shown
  // to friends and room members — not encrypted.
  bio: { type: String, trim: true, maxlength: [140, 'Bio too long'], default: '' },
  avatarPreset: { type: String, default: null },
  avatarImage: { type: String, default: '' },
  // Mood glow (v0.7.0): free / busy / chilling — a colour + pulse on
  // the user's orb, replacing status text (playbook p.5). Public
  // profile data like bio/avatar, shown to room members via
  // presence. Legacy rows have no field and read as 'free' (see
  // lib/mood.js normalizeMood); the enum keeps hand-rolled clients
  // from storing a state the UI has no style for.
  mood: { type: String, enum: ['free', 'busy', 'chilling'], default: 'free' },
  // Google account id for one-tap sign-in. Sparse + unique: password-only
  // users have no googleId, and one Google account links to one user.
  googleId: { type: String, unique: true, sparse: true, index: true, default: undefined },
  // Email verification (audit M1): accounts created before verification
  // existed have NO field here and count as verified — see
  // lib/emailVerification.js isEmailVerified(). New registrations set
  // this to false explicitly until they verify; Google sign-ups set it
  // to true (Google attests the email). No default: an absent field
  // must keep meaning "grandfathered", not "unverified".
  emailVerified: { type: Boolean, default: undefined },
  passwordHash: { type: String, required: true },
  passwordSalt: { type: String, required: true }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
