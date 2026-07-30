'use strict';
/**
 * The "Connect" flow — this replaces manual PIN entry entirely.
 *
 * How it works, mirroring Bluetooth pairing:
 *  1. Person A clicks "Connect" on Bob's device, confirms "Connect to Bob's
 *     Phone?" — this calls ConnectClient.connect().
 *  2. That opens a small TCP connection directly to Bob's device and sends a
 *     connect_request containing Alice's identity + public key. A's UI
 *     immediately shows "Waiting for Bob to accept... Code: 483920" — that
 *     code is computed from both public keys, which both sides now have.
 *  3. Bob's device (running ConnectServer) gets the request and shows a
 *     popup: "Ada's Laptop wants to connect. Code: 483920 — does this match
 *     their screen? [Accept] [Decline]" — this is the human check step,
 *     equivalent to Bluetooth's numeric-comparison pairing.
 *  4. If Bob accepts, both sides independently derive the same session key
 *     from pure ECDH (their private key + the other's public key — no PIN
 *     needed, since the interactive accept step already proves both parties
 *     are actively present and cooperating). Both store the pairing. Alice's
 *     "waiting" screen resolves to "connected" and opens the chat.
 *  5. If Bob declines (or doesn't respond within 20s), Alice sees that
 *     instead.
 *
 * Threat model note: this authenticates "the device I can currently reach at
 * this IP, whose owner just clicked Accept" — same trust level as Bluetooth
 * "Just Works"/numeric-comparison pairing. It does not protect against an
 * attacker who can both intercept the connection *and* get the human to
 * click Accept on a lookalike prompt. Fine for a v1 LAN app.
 */
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const cryptoCore = require('./crypto');

const CONNECT_PORT = 47120; // default; overridable per-self via self.connectPort (mirrors chatPort/transferPort)
const CONNECT_TIMEOUT_MS = 20000;

function writeFrame(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

function readOneFrame(socket, onFrame) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) return;
    const len = buffer.readUInt32BE(0);
    if (buffer.length < 4 + len) return;
    onFrame(JSON.parse(buffer.subarray(4, 4 + len).toString('utf8')));
  });
}

/** Runs on every device, always-on: listens for incoming connect requests. */
class ConnectServer extends EventEmitter {
  constructor(self, trustStore) {
    super();
    this.self = self;
    this.trustStore = trustStore;
    this.server = null;
  }

  start() {
    this.server = net.createServer((socket) => this._handle(socket));
    this.server.listen(this.self.connectPort || CONNECT_PORT);
  }

  _handle(socket) {
    readOneFrame(socket, (msg) => {
      if (msg.type !== 'connect_request') return;
      const code = cryptoCore.verificationCode(this.self.publicKeyRaw, msg.publicKeyRaw);

      this.emit('incoming', {
        deviceId: msg.deviceId,
        name: msg.name,
        code,
        respond: (accept) => {
          if (accept) {
            const theirPublicKey = cryptoCore.importPublicKeyRaw(Buffer.from(msg.publicKeyRaw, 'hex'));
            const sessionKey = cryptoCore.deriveConnectSessionKey(this.self.keyPair.privateKey, theirPublicKey);
            this.trustStore.addPaired(msg.deviceId, msg.name, Buffer.from(msg.publicKeyRaw, 'hex'), sessionKey);
            writeFrame(socket, { type: 'connect_accept', deviceId: this.self.deviceId, name: this.self.name, publicKeyRaw: this.self.publicKeyRaw });
          } else {
            writeFrame(socket, { type: 'connect_reject' });
          }
          socket.end();
        },
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

/** The initiating side of a Connect action. */
class ConnectClient {
  constructor(self, trustStore) {
    this.self = self;
    this.trustStore = trustStore;
  }

  /**
   * @param {object} peer - from Discovery.list(), must include publicKeyRaw
   * @param {(code:string)=>void} onWaiting - fired immediately with the verification code, before the other side has responded
   * @returns {Promise<{status:'accepted'|'rejected'|'timeout', code:string}>}
   */
  connect(peer, onWaiting) {
    if (!peer.publicKeyRaw) {
      return Promise.reject(new Error(
        `${peer.name} hasn't broadcast a public key yet — this usually means their app just started. ` +
        `Wait a few seconds for it to reappear in "Nearby devices" and try again.`
      ));
    }
    const code = cryptoCore.verificationCode(this.self.publicKeyRaw, peer.publicKeyRaw);

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.createConnection({ host: peer.ip, port: peer.connectPort || CONNECT_PORT }, () => {
        writeFrame(socket, { type: 'connect_request', deviceId: this.self.deviceId, name: this.self.name, publicKeyRaw: this.self.publicKeyRaw });
        onWaiting?.(code);
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ status: 'timeout', code });
      }, CONNECT_TIMEOUT_MS);

      readOneFrame(socket, (msg) => {
        if (settled) return;
        if (msg.type === 'connect_accept') {
          const theirPublicKey = cryptoCore.importPublicKeyRaw(Buffer.from(msg.publicKeyRaw, 'hex'));
          const sessionKey = cryptoCore.deriveConnectSessionKey(this.self.keyPair.privateKey, theirPublicKey);
          this.trustStore.addPaired(msg.deviceId, msg.name, Buffer.from(msg.publicKeyRaw, 'hex'), sessionKey);
          settled = true;
          clearTimeout(timer);
          resolve({ status: 'accepted', code });
        } else if (msg.type === 'connect_reject') {
          settled = true;
          clearTimeout(timer);
          resolve({ status: 'rejected', code });
        }
      });

      socket.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

module.exports = { ConnectServer, ConnectClient, CONNECT_PORT };
