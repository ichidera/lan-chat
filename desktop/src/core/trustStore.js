'use strict';
/**
 * Tracks which peers we've paired with, and the session key derived for each.
 * Kept dead simple: one JSON file on desktop, one small Room table on Android.
 * Nothing here ever leaves the device.
 */
const fs = require('fs');
const path = require('path');

class TrustStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.peers = new Map(); // deviceId -> { name, publicKeyRaw(hex), sessionKey(hex) }
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const [id, v] of Object.entries(raw)) this.peers.set(id, v);
    } catch {
      // no store yet — fine, start empty
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const obj = Object.fromEntries(this.peers);
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
  }

  addPaired(deviceId, name, publicKeyRaw, sessionKey) {
    this.peers.set(deviceId, {
      name,
      publicKeyRaw: publicKeyRaw.toString('hex'),
      sessionKey: sessionKey.toString('hex'),
      pairedAt: Date.now(),
    });
    this._save();
  }

  isPaired(deviceId) {
    return this.peers.has(deviceId);
  }

  sessionKeyFor(deviceId) {
    const p = this.peers.get(deviceId);
    return p ? Buffer.from(p.sessionKey, 'hex') : null;
  }

  list() {
    return Array.from(this.peers.entries()).map(([deviceId, v]) => ({ deviceId, ...v }));
  }
}

module.exports = { TrustStore };
