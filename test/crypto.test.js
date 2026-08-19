'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// A fixed key so the round-trip is deterministic (32 bytes, base64).
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { encrypt, decrypt } = require('../src/crypto');

test('encrypt/decrypt round-trips an API key', () => {
  const secret = 'sk-proj-abcDEF123456';
  const blob = encrypt(secret);
  assert.ok(Buffer.isBuffer(blob));
  assert.notEqual(blob.toString('utf8'), secret); // not stored in the clear
  assert.equal(decrypt(blob), secret);
});

test('each encryption uses a fresh nonce (ciphertexts differ)', () => {
  assert.notEqual(encrypt('same').toString('hex'), encrypt('same').toString('hex'));
});

test('decrypt(null) is null; tampering is rejected', () => {
  assert.equal(decrypt(null), null);
  const blob = encrypt('tamper me');
  blob[blob.length - 1] ^= 0xff; // corrupt the ciphertext
  assert.throws(() => decrypt(blob));
});
