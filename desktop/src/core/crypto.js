'use strict';
/**
 * Minimal, dependency-free crypto layer using Node's built-in `crypto` module.
 * X25519 for the key exchange, AES-256-GCM for the authenticated encryption
 * of every message/chunk once paired.
 *
 * NOTE ON CIPHER CHOICE: this used to use ChaCha20-Poly1305. That algorithm
 * is not available in every Electron build's bundled OpenSSL on every OS —
 * some Windows builds throw "Error: Unknown cipher" for it. AES-256-GCM is
 * mandated by TLS itself, so it's guaranteed present everywhere Node/Electron
 * runs; that's why it's used here instead, even though ChaCha20 is a fine
 * algorithm in principle.
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
 * Legacy PIN-salted derivation. No longer used by the main connect flow
 * (see deriveConnectSessionKey below) but kept here since it's a harmless,
 * documented alternative and existing tests/tools may reference it.
 */
function deriveSessionKey(myPrivateKey, theirPublicKey, pin) {
  const shared = crypto.diffieHellman({ privateKey: myPrivateKey, publicKey: theirPublicKey });
  const salt = Buffer.from(String(pin));
  const key = crypto.hkdfSync('sha256', shared, salt, Buffer.from('lan-chat-v1'), 32);
  return Buffer.from(key);
}

/**
 * Used by the interactive "Connect" flow (see pairing.js): derives a session
 * key from pure ECDH, no PIN. The HKDF salt is fixed/public — that's normal
 * for HKDF, the actual secret input is the ECDH shared secret itself, which
 * only the two holders of the matching private keys can compute.
 */
function deriveConnectSessionKey(myPrivateKey, theirPublicKey) {
  const shared = crypto.diffieHellman({ privateKey: myPrivateKey, publicKey: theirPublicKey });
  const key = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('lan-chat-connect-v1'), 32);
  return Buffer.from(key);
}

/**
 * A short human-checkable number both sides can compute independently once
 * they each know both public keys — this is what's shown on screen during
 * the Connect flow so a person can eyeball "yes, same number on both
 * screens" (the same idea as Bluetooth's numeric-comparison pairing).
 * Order-independent: sorting the two hex strings means it doesn't matter
 * which side is "self" and which is "peer".
 */
function verificationCode(pubKeyHexA, pubKeyHexB) {
  const [a, b] = [pubKeyHexA, pubKeyHexB].sort();
  const hash = crypto.createHash('sha256').update(a + b).digest();
  const num = hash.readUInt32BE(0) % 1000000;
  return num.toString().padStart(6, '0');
}

// Frame layout is [12-byte nonce][ciphertext][16-byte tag] — chosen to match
// Google Tink's AEAD subtle primitives byte-for-byte, since the Android
// client uses Tink for the same algorithm. Keeping the on-wire layout
// identical means neither side needs any translation logic.
function encrypt(sessionKey, plaintextBuf) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]); // [12 nonce][N ciphertext][16 tag]
}

function decrypt(sessionKey, frameBuf) {
  const nonce = frameBuf.subarray(0, 12);
  const tag = frameBuf.subarray(frameBuf.length - 16);
  const ciphertext = frameBuf.subarray(12, frameBuf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function randomPin() {
  return crypto.randomInt(100000, 999999).toString();
}

module.exports = {
  generateKeyPair, exportPublicKeyRaw, importPublicKeyRaw,
  deriveSessionKey, deriveConnectSessionKey, verificationCode,
  encrypt, decrypt, randomPin,
};
