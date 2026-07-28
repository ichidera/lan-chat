'use strict';
/**
 * Minimal, dependency-free crypto layer using Node's built-in `crypto` module.
 * X25519 for the key exchange (pairing), ChaCha20-Poly1305 for the authenticated
 * encryption of every message/chunk once paired. No custom primitives — only
 * well-known standard algorithms, wired together simply on purpose.
 */
const crypto = require('crypto');

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey, privateKey };
}

function exportPublicKeyRaw(publicKeyObj) {
  // raw 32-byte form, easy to put in a QR code / JSON payload
  return publicKeyObj.export({ type: 'spki', format: 'der' }).subarray(-32);
}

function importPublicKeyRaw(rawBuf) {
  const der = Buffer.concat([
    Buffer.from('302a300506032b656e032100', 'hex'), // x25519 SPKI DER prefix
    rawBuf,
  ]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Derives a symmetric session key from our private key + their public key,
 * salted with the PIN used during pairing (so a passive LAN listener who
 * doesn't know the PIN can't derive the same key even if they captured both
 * public keys in transit).
 */
function deriveSessionKey(myPrivateKey, theirPublicKey, pin) {
  const shared = crypto.diffieHellman({ privateKey: myPrivateKey, publicKey: theirPublicKey });
  const salt = Buffer.from(String(pin));
  const key = crypto.hkdfSync('sha256', shared, salt, Buffer.from('lan-chat-v1'), 32);
  return Buffer.from(key);
}

// Frame layout is [12-byte nonce][ciphertext][16-byte tag] — chosen to match
// Google Tink's ChaCha20Poly1305 subtle primitive byte-for-byte, since the
// Android client uses Tink for this exact algorithm. Keeping the on-wire
// layout identical means neither side needs any translation logic.
function encrypt(sessionKey, plaintextBuf) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('chacha20-poly1305', sessionKey, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]); // [12 nonce][N ciphertext][16 tag]
}

function decrypt(sessionKey, frameBuf) {
  const nonce = frameBuf.subarray(0, 12);
  const tag = frameBuf.subarray(frameBuf.length - 16);
  const ciphertext = frameBuf.subarray(12, frameBuf.length - 16);
  const decipher = crypto.createDecipheriv('chacha20-poly1305', sessionKey, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function randomPin() {
  return crypto.randomInt(100000, 999999).toString();
}

module.exports = {
  generateKeyPair, exportPublicKeyRaw, importPublicKeyRaw,
  deriveSessionKey, encrypt, decrypt, randomPin,
};
