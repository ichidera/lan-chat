'use strict';
/**
 * Chat transport: one persistent TCP connection per peer, framed as
 * [4-byte big-endian length][frame bytes]. The very first frame on any new
 * connection is always plaintext JSON: {"type":"hello","deviceId":"..."}.
 * Every frame after that is ciphertext (see core/crypto.js) using the
 * session key for that deviceId — so we know who we're talking to before we
 * try to decrypt anything.
 */
const net = require('net');
const EventEmitter = require('events');
const cryptoCore = require('./crypto');

function writeFrame(socket, buf) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(buf.length, 0);
  socket.write(Buffer.concat([header, buf]));
}

// Generic length-prefixed frame reader bound to a socket.
function frameReader(socket, onFrame) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32BE(0);
      if (buffer.length < 4 + len) break;
      const frame = buffer.subarray(4, 4 + len);
      buffer = buffer.subarray(4 + len);
      onFrame(frame);
    }
  });
}

class ChatNode extends EventEmitter {
  /**
   * @param {{deviceId, name, chatPort}} self
   * @param {TrustStore} trustStore
   */
  constructor(self, trustStore) {
    super();
    this.self = self;
    this.trustStore = trustStore;
    this.server = null;
    this.connections = new Map(); // deviceId -> socket
  }

  start() {
    this.server = net.createServer((socket) => this._handleIncoming(socket));
    this.server.listen(this.self.chatPort, () => {
      this.emit('listening', this.self.chatPort);
    });
  }

  _handleIncoming(socket) {
    let peerDeviceId = null;
    frameReader(socket, (frame) => {
      if (!peerDeviceId) {
        // first frame must be the plaintext hello
        const hello = JSON.parse(frame.toString('utf8'));
        peerDeviceId = hello.deviceId;
        this.connections.set(peerDeviceId, socket);
        this.emit('connection', peerDeviceId);
        return;
      }
      const sessionKey = this.trustStore.sessionKeyFor(peerDeviceId);
      if (!sessionKey) {
        this.emit('error', new Error(`Received message from unpaired peer ${peerDeviceId}`));
        socket.destroy();
        return;
      }
      const plaintext = cryptoCore.decrypt(sessionKey, frame);
      const msg = JSON.parse(plaintext.toString('utf8'));
      this.emit('message', { from: peerDeviceId, msg });
    });
    socket.on('close', () => {
      if (peerDeviceId) this.connections.delete(peerDeviceId);
    });
  }

  /** Opens (or reuses) a connection to a peer and sends one chat message. */
  send(peer, msg) {
    return new Promise((resolve, reject) => {
      const sessionKey = this.trustStore.sessionKeyFor(peer.deviceId);
      if (!sessionKey) return reject(new Error('Cannot send: peer is not paired yet'));

      let socket = this.connections.get(peer.deviceId);
      const doSend = () => {
        const plaintext = Buffer.from(JSON.stringify(msg), 'utf8');
        writeFrame(socket, cryptoCore.encrypt(sessionKey, plaintext));
        resolve();
      };

      if (socket && !socket.destroyed) return doSend();

      socket = net.createConnection({ host: peer.ip, port: peer.chatPort }, () => {
        writeFrame(socket, Buffer.from(JSON.stringify({ type: 'hello', deviceId: this.self.deviceId }), 'utf8'));
        this.connections.set(peer.deviceId, socket);
        doSend();
      });
      socket.on('error', reject);
      frameReader(socket, (frame) => {
        const plaintext = cryptoCore.decrypt(sessionKey, frame);
        this.emit('message', { from: peer.deviceId, msg: JSON.parse(plaintext.toString('utf8')) });
      });
    });
  }

  stop() {
    for (const s of this.connections.values()) s.destroy();
    if (this.server) this.server.close();
  }
}

module.exports = { ChatNode };
