'use strict';
/**
 * Presence / discovery over UDP broadcast.
 * Mirrors protocol/PROTOCOL.md §3 exactly — the Android NsdHelper/UdpDiscovery
 * class must produce/consume the same JSON shape.
 */
const dgram = require('dgram');
const EventEmitter = require('events');

const DISCOVERY_PORT = 47110;
const BROADCAST_ADDR = '255.255.255.255';
const ANNOUNCE_INTERVAL_MS = 3000;
const PEER_TIMEOUT_MS = 10000;

class Discovery extends EventEmitter {
  /**
   * @param {{deviceId:string, name:string, chatPort:number, transferPort:number}} self
   */
  constructor(self) {
    super();
    this.self = self;
    this.peers = new Map(); // deviceId -> {..., lastSeen}
    this.socket = null;
    this._announceTimer = null;
    this._sweepTimer = null;
  }

  start() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('message', (msg, rinfo) => {
      let packet;
      try {
        packet = JSON.parse(msg.toString('utf8'));
      } catch {
        return; // ignore garbage
      }
      if (packet.type !== 'presence' || packet.deviceId === this.self.deviceId) return;

      const isNew = !this.peers.has(packet.deviceId);
      this.peers.set(packet.deviceId, {
        ...packet,
        ip: rinfo.address,
        lastSeen: Date.now(),
      });
      this.emit(isNew ? 'peer:new' : 'peer:update', this.peers.get(packet.deviceId));
    });

    this.socket.bind(DISCOVERY_PORT, () => {
      this.socket.setBroadcast(true);
      this._announceTimer = setInterval(() => this._announce(), ANNOUNCE_INTERVAL_MS);
      this._announce(); // immediate first announce
      this._sweepTimer = setInterval(() => this._sweepStalePeers(), 2000);
    });
  }

  _announce() {
    const payload = Buffer.from(JSON.stringify({
      type: 'presence',
      deviceId: this.self.deviceId,
      name: this.self.name,
      kind: 'desktop',
      chatPort: this.self.chatPort,
      transferPort: this.self.transferPort,
      version: 1,
      ts: Date.now(),
    }));
    this.socket.send(payload, 0, payload.length, DISCOVERY_PORT, BROADCAST_ADDR);
  }

  _sweepStalePeers() {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
        this.peers.delete(id);
        this.emit('peer:gone', peer);
      }
    }
  }

  list() {
    return Array.from(this.peers.values());
  }

  stop() {
    clearInterval(this._announceTimer);
    clearInterval(this._sweepTimer);
    if (this.socket) this.socket.close();
  }
}

module.exports = { Discovery, DISCOVERY_PORT };
