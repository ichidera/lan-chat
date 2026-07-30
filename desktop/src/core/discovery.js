'use strict';
/**
 * Presence / discovery over UDP.
 * Mirrors protocol/PROTOCOL.md §3 exactly — the Android Discovery.kt class
 * must produce/consume the same JSON shape.
 *
 * DETECTION LAYERS (this is the fix for "sometimes it doesn't see phones"):
 * A single `send to 255.255.255.255` often fails to leave the right network
 * interface on machines with multiple adapters (Wi-Fi + Ethernet, a VPN
 * adapter, Hyper-V/VMware virtual switches, etc.) — Windows in particular
 * will pick one default route and the global broadcast may go out the wrong
 * NIC entirely. So every announce is sent three ways:
 *   1. Global broadcast (255.255.255.255) — works on simple single-NIC setups.
 *   2. The subnet broadcast address computed per active network interface
 *      (e.g. 192.168.1.255 for a 192.168.1.0/24 Wi-Fi adapter) — this is the
 *      layer that fixes most "phone doesn't show up" cases, because it's
 *      targeted at the actual interface the phone is reachable from.
 *   3. A multicast fallback (239.255.255.250:47110) — multicast is routed
 *      differently than broadcast by some routers/firewalls, so it catches
 *      the rare case where broadcast is filtered but multicast isn't.
 * Losing any one layer still leaves the others; this is deliberately
 * redundant rather than trying to pick the "one correct" method.
 */
const dgram = require('dgram');
const os = require('os');
const EventEmitter = require('events');

const DISCOVERY_PORT = 47110;
const GLOBAL_BROADCAST_ADDR = '255.255.255.255';
const MULTICAST_ADDR = '239.255.255.250';
const ANNOUNCE_INTERVAL_MS = 3000;
const PEER_TIMEOUT_MS = 12000; // slightly > 3x announce interval so one dropped packet doesn't expire a peer

/** IPv4 string -> 32-bit unsigned int */
function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}
function intToIp(int) {
  return [24, 16, 8, 0].map((shift) => (int >>> shift) & 0xff).join('.');
}

/** Every subnet broadcast address this machine can currently reach, computed from each active IPv4 interface. */
function getInterfaceBroadcastAddresses() {
  const addrs = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (!iface.netmask) continue;
      const ipInt = ipToInt(iface.address);
      const maskInt = ipToInt(iface.netmask);
      const broadcastInt = (ipInt & maskInt) | (~maskInt >>> 0);
      addrs.push(intToIp(broadcastInt));
    }
  }
  return [...new Set(addrs)];
}

class Discovery extends EventEmitter {
  /**
   * @param {{deviceId:string, name:string, chatPort:number, transferPort:number, publicKeyRaw:string}} self
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
        return; // ignore garbage / non-JSON traffic on this port
      }
      if (packet.type !== 'presence' || packet.deviceId === this.self.deviceId) return;

      const isNew = !this.peers.has(packet.deviceId);
      this.peers.set(packet.deviceId, {
        ...packet,
        ip: rinfo.address,
        lastSeen: Date.now(),
      });
      this.emit(isNew ? 'peer:new' : 'peer:update', this.peers.get(packet.deviceId));

      // If this is the first time we've heard from this peer, unicast our
      // own presence straight back to their address immediately. This fixes
      // the common asymmetric case where broadcast reaches A->B fine but
      // B->A is somehow lossy or blocked (different subnet quirks, timing,
      // a flaky adapter) — B just heard from A, so B can reply directly to
      // A's IP without waiting on broadcast to work in that direction too.
      if (isNew) this._sendTo(rinfo.address, rinfo.port || DISCOVERY_PORT);
    });

    this.socket.on('error', (err) => this.emit('error', err));

    this.socket.bind(DISCOVERY_PORT, () => {
      this.socket.setBroadcast(true);
      try {
        this.socket.addMembership(MULTICAST_ADDR);
      } catch (err) {
        // Some networks (or sandboxed/VPN environments) refuse multicast group
        // membership — that's fine, broadcast layers still work.
        this.emit('error', new Error(`multicast join failed (non-fatal): ${err.message}`));
      }
      this._announceTimer = setInterval(() => this._announce(), ANNOUNCE_INTERVAL_MS);
      this._announce(); // immediate first announce, don't wait 3s to become visible
      this._sweepTimer = setInterval(() => this._sweepStalePeers(), 2000);
    });
  }

  _presencePayload() {
    return Buffer.from(JSON.stringify({
      type: 'presence',
      deviceId: this.self.deviceId,
      name: this.self.name,
      kind: 'desktop',
      chatPort: this.self.chatPort,
      transferPort: this.self.transferPort,
      connectPort: this.self.connectPort,
      publicKeyRaw: this.self.publicKeyRaw, // public keys are not secret — broadcasting them is what lets pairing skip manual copy/paste
      version: 1,
      ts: Date.now(),
    }));
  }

  _sendTo(addr, port = DISCOVERY_PORT) {
    const payload = this._presencePayload();
    this.socket.send(payload, 0, payload.length, port, addr, (err) => {
      if (err) this.emit('error', new Error(`send to ${addr} failed (non-fatal): ${err.message}`));
    });
  }

  _announce() {
    const targets = [GLOBAL_BROADCAST_ADDR, MULTICAST_ADDR, ...getInterfaceBroadcastAddresses()];
    for (const addr of targets) this._sendTo(addr);
  }

  /**
   * Manual fallback for "Connect by IP": sends one unicast presence packet
   * directly to a specific address, bypassing broadcast/multicast entirely.
   * Useful when a device genuinely can't be reached by either (different
   * subnet, unusual router config) but a direct IP is routable. If it
   * arrives, the reply-on-new-peer behavior above means the target device
   * will unicast its own presence straight back — so one working direction
   * is enough to discover each other.
   */
  probe(ip) {
    this._sendTo(ip, DISCOVERY_PORT);
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
