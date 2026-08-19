'use strict';

// Symmetric encryption for the per-user API keys stored in Postgres. A database
// dump alone must not leak anyone's Lunchflow/OpenAI credentials, so the keys
// are AES-256-GCM encrypted with ENCRYPTION_KEY (which lives only in env).

const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;

function loadKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)');
    }
    return key;
  }
  if (IS_PROD) {
    console.error('ENCRYPTION_KEY must be set in production');
    process.exit(1);
  }
  // Dev fallback: a fixed key so encrypted values survive restarts locally,
  // mirroring how auth derives a dev password. Never used in production.
  console.warn('No ENCRYPTION_KEY set — using an insecure fixed dev key');
  return crypto.createHash('sha256').update('finance-dev-encryption-key').digest();
}

const KEY = loadKey();

// Returns a Buffer: iv(12) ‖ authTag(16) ‖ ciphertext. Store it in a BYTEA.
function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

// Inverse of encrypt(). Accepts a Buffer (or null → null).
function decrypt(buf) {
  if (buf == null) return null;
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
