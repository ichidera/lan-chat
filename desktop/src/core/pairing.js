'use strict';
/**
 * Pairing = the one moment a human is involved. Everything else is automatic.
 *
 * How it actually works now: every device already broadcasts its public key
 * in its presence packet (see discovery.js — public keys aren't secret, so
 * there's nothing to hide by not doing this). That means the *only* thing
 * two people need to exchange out of band is a short PIN — spoken aloud,
 * texted, whatever. No copy-pasting JSON blobs between devices.
 *
 * Flow:
 *  1. Person A clicks Bob's entry in "Nearby devices". Since they're not
 *     paired yet, a dialog opens with a freshly generated 6-digit PIN.
 *  2. Person A tells that PIN to Bob (out loud, over text, however).
 *  3. Bob clicks Alice's entry on his device, and types that PIN into the
 *     same dialog instead of using the one it generated for him.
 *  4. Both sides call pairWithPeer() with (their own private key, the
 *     peer's already-known public key from discovery, the shared PIN) and
 *     independently derive the identical session key. Nothing needs to be
 *     sent back and forth to "confirm" — if both sides used the same PIN,
 *     every future encrypted message between them will simply decrypt
 *     correctly. If they used different PINs, decryption will fail loudly
 *     (AEAD auth failure) rather than silently producing garbage.
 *
 * Note on threat model: this is a PIN-salted ECDH, not a full PAKE (e.g.
 * SPAKE2). It stops a passive network observer who didn't see the PIN. It's
 * intentionally simple for a v1 LAN app — flagged here so nobody mistakes it
 * for research-grade crypto.
 */
const cryptoCore = require('./crypto');

function generatePin() {
  return cryptoCore.randomPin();
}

/**
 * @param {object} self - {deviceId, name, keyPair}
 * @param {object} peer - a peer object from Discovery.list(), MUST include publicKeyRaw
 * @param {string} pin - the 6-digit PIN both humans agreed to use
 * @param {TrustStore} trustStore
 */
function pairWithPeer(self, peer, pin, trustStore) {
  if (!peer.publicKeyRaw) {
    throw new Error(
      `${peer.name} hasn't broadcast a public key yet — this usually means their app just started. ` +
      `Wait a few seconds for it to reappear in "Nearby devices" and try again.`
    );
  }
  if (!/^\d{6}$/.test(String(pin))) {
    throw new Error('PIN must be exactly 6 digits.');
  }
  const theirPublicKey = cryptoCore.importPublicKeyRaw(Buffer.from(peer.publicKeyRaw, 'hex'));
  const sessionKey = cryptoCore.deriveSessionKey(self.keyPair.privateKey, theirPublicKey, pin);
  trustStore.addPaired(peer.deviceId, peer.name, Buffer.from(peer.publicKeyRaw, 'hex'), sessionKey);
  return sessionKey;
}

module.exports = { generatePin, pairWithPeer };
