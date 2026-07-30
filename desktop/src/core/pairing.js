'use strict';
/**
function generatePin() {
  return cryptoCore.randomPin();
}

/**
 * @param {object} self - {deviceId, name, keyPair}
 * @param {object} peer - a peer object from Discovery.list(), MUST include publicKeyRaw
 * @param {string} pin - the 6-digit PIN both humans agreed to use
 * @param {TrustStore} trustStore
 */
 */
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const cryptoCore = require('./crypto');

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

