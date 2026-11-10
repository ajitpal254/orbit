// Field-level encryption for stored data (AES-256-GCM).
//
// What it covers: chat message text and room topics — the content users
// type. What it deliberately does NOT cover:
//   - user emails / names: needed for login lookup and Google OAuth matching
//   - passwords: already PBKDF2-hashed; hashing is correct, never encrypt
//     passwords (encryption is reversible, hashing is not)
//   - voice: already DTLS-SRTP encrypted peer-to-peer; the server never
//     receives media at all
//
// Key: 32 bytes, base64-encoded, from the DATA_ENCRYPTION_KEY env var.
// If it is missing (or not 32 bytes once decoded), an ephemeral key is
// generated at boot and a LOUD warning is logged: anything encrypted with
// it becomes unreadable after a server restart. That is a dev convenience,
// never silent — production must set a persistent key.
//
// ⚠️ LOSING THE KEY MAKES OLD MESSAGES PERMANENTLY UNREADABLE. There is
// no recovery: AES-256-GCM with a lost key cannot be brute-forced.
// Keep the key in Render env vars. Never commit it.
//
// Wire format: one base64 string, "iv:authTag:ciphertext". A fresh random
// 12-byte IV per message means identical plaintexts encrypt differently.
const crypto = require('crypto');
const logger = require('./logger');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

let cachedKey = null;
let ephemeral = false;

const getKey = () => {
  if (cachedKey) return cachedKey;
  const b64 = process.env.DATA_ENCRYPTION_KEY;
  if (b64) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
    logger.warn(
      'DATA_ENCRYPTION_KEY is set but does not decode to 32 bytes — ' +
      'generating an ephemeral key instead. Set a valid 32-byte base64 key.'
    );
  }
  cachedKey = crypto.randomBytes(32);
  ephemeral = true;
  logger.warn(
    'DATA_ENCRYPTION_KEY is not set — generated an EPHEMERAL encryption key. ' +
    'Stored messages will be UNREADABLE after a server restart. ' +
    'Set a persistent DATA_ENCRYPTION_KEY (generate with: ' +
    "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\")"
  );
  return cachedKey;
};

// True once getKey() has fallen back to an ephemeral key.
const isKeyEphemeral = () => {
  getKey();
  return ephemeral;
};

const encrypt = (plaintext) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64')
  ].join(':');
};

const decrypt = (blob) => {
  const parts = String(blob).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format');
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  // Throws if the ciphertext or tag was tampered with — by design.
  // Never swallow this: silent corruption is worse than a loud failure.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

// Test-only: drop the cached key so a fresh key (or env value) is picked up.
const _resetKeyCacheForTests = () => {
  cachedKey = null;
  ephemeral = false;
};

module.exports = { encrypt, decrypt, getKey, isKeyEphemeral, _resetKeyCacheForTests };
