'use strict';
/**
 * Pairing = the one moment a human is involved. Everything after this is automatic.
 *
 * Flow:
 *  1. Device A calls startPairing() -> gets {deviceId, publicKeyRaw, pin}.
 *     It shows the PIN (and/or a QR code encoding the same payload) on screen.
 *  2. Device B's user reads/scans that and calls completePairing() with it.
 *  3. Both sides independently derive the same session key from
 *     (their own private key, the other's public key, the shared PIN) and store
 *     it in their TrustStore keyed by deviceId.
 *
 * Note on threat model: this is a PIN-salted ECDH, not a full PAKE (e.g. SPAKE2).
 * It stops a passive network observer who didn't see the PIN. It's intentionally
 * simple for a v1 LAN app — flagged here so nobody mistakes it for
 * research-grade crypto.
 */
const cryptoCore = require('./crypto');

function startPairing(self) {
  const pin = cryptoCore.randomPin();
  const publicKeyRaw = cryptoCore.exportPublicKeyRaw(self.keyPair.publicKey);
  return {
    deviceId: self.deviceId,
    name: self.name,
    publicKeyRaw: publicKeyRaw.toString('hex'),
    pin,
  };
}

/**
 * @param {object} offer - the payload from startPairing() on the other device
 * @param {object} self - {deviceId, name, keyPair}
 * @param {TrustStore} trustStore
 */
function completePairing(offer, self, trustStore) {
  const theirPublicKey = cryptoCore.importPublicKeyRaw(Buffer.from(offer.publicKeyRaw, 'hex'));
  const sessionKey = cryptoCore.deriveSessionKey(self.keyPair.privateKey, theirPublicKey, offer.pin);
  trustStore.addPaired(offer.deviceId, offer.name, Buffer.from(offer.publicKeyRaw, 'hex'), sessionKey);
  return sessionKey;
}

/**
 * The initiating device also needs to compute the *same* session key once it
 * learns the other side's public key back (a real UI would exchange both ways,
 * e.g. via QR-then-confirm, or a short back-and-forth over the discovery
 * channel). Exposed separately so both directions use one code path.
 */
function deriveMatchingKey(self, theirPublicKeyRawHex, pin) {
  const theirPublicKey = cryptoCore.importPublicKeyRaw(Buffer.from(theirPublicKeyRawHex, 'hex'));
  return cryptoCore.deriveSessionKey(self.keyPair.privateKey, theirPublicKey, pin);
}

module.exports = { startPairing, completePairing, deriveMatchingKey };
