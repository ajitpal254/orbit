// Password hashing (PBKDF2-SHA512) and secure token helpers.
const crypto = require('crypto');

const PBKDF2_ITERATIONS = 310000;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

const hashPassword = (password, salt, iterations = PBKDF2_ITERATIONS) =>
  crypto.pbkdf2Sync(password, salt, iterations, KEY_BYTES, 'sha512').toString('hex');

const newSalt = () => crypto.randomBytes(SALT_BYTES).toString('hex');

const generateToken = () => crypto.randomBytes(32).toString('hex');

// SHA-256 hash for session tokens stored in the DB (tokens themselves are
// only ever in the httpOnly cookie).
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

module.exports = { hashPassword, newSalt, generateToken, hashToken, PBKDF2_ITERATIONS };
