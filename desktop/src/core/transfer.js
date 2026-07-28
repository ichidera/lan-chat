'use strict';
/**
 * File/app transfer ("Xender" capability).
 *
 * One small encrypted control connection (transferPort) negotiates the
 * transfer (offer -> accept -> complete). The actual bytes move over N
 * parallel *raw* TCP sockets (transferPort+1 .. transferPort+N), each one
 * responsible for a contiguous byte range of the file — this is what gives
 * LAN transfers real throughput instead of single-stream TCP being the
 * bottleneck.
 */
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');
const cryptoCore = require('./crypto');

const PARALLEL_STREAMS = 4;

function uuidToBuf16(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}
function bufToUuid(buf) {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function writeControlFrame(socket, sessionKey, obj) {
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = cryptoCore.encrypt(sessionKey, plaintext);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(enc.length, 0);
  socket.write(Buffer.concat([header, enc]));
}

function controlFrameReader(socket, sessionKey, onMessage) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32BE(0);
      if (buffer.length < 4 + len) break;
      const frame = buffer.subarray(4, 4 + len);
      buffer = buffer.subarray(4 + len);
      const plaintext = cryptoCore.decrypt(sessionKey, frame);
      onMessage(JSON.parse(plaintext.toString('utf8')));
    }
  });
}

function byteRanges(size, n) {
  const ranges = [];
  const base = Math.floor(size / n);
  let start = 0;
  for (let i = 0; i < n; i++) {
    const len = i === n - 1 ? size - start : base;
    ranges.push({ start, end: start + len - 1 }); // inclusive, fs.createReadStream style
    start += len;
  }
  return ranges;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

class TransferServer extends EventEmitter {
  constructor(self, trustStore, receivedDir) {
    super();
    this.self = self;
    this.trustStore = trustStore;
    this.receivedDir = receivedDir;
    this.transfers = new Map(); // transferId -> { files, destPaths, streamsRemaining, sessionKey, controlSocket }
    this.controlServer = null;
    this.dataServers = [];
  }

  start() {
    fs.mkdirSync(this.receivedDir, { recursive: true });

    this.controlServer = net.createServer((socket) => this._handleControl(socket));
    this.controlServer.listen(this.self.transferPort);

    for (let i = 1; i <= PARALLEL_STREAMS; i++) {
      const srv = net.createServer((socket) => this._handleData(socket));
      srv.listen(this.self.transferPort + i);
      this.dataServers.push(srv);
    }
  }

  _handleControl(socket) {
    let peerDeviceId = null;
    let sessionKey = null;
    let buffer = Buffer.alloc(0);

    socket.once('data', (chunk) => {
      // first plaintext frame: hello
      const len = chunk.readUInt32BE(0);
      const helloFrame = chunk.subarray(4, 4 + len);
      const hello = JSON.parse(helloFrame.toString('utf8'));
      peerDeviceId = hello.deviceId;
      sessionKey = this.trustStore.sessionKeyFor(peerDeviceId);
      if (!sessionKey) { socket.destroy(); return; }

      buffer = chunk.subarray(4 + len);
      const processRemaining = () => {
        while (buffer.length >= 4) {
          const l = buffer.readUInt32BE(0);
          if (buffer.length < 4 + l) break;
          const frame = buffer.subarray(4, 4 + l);
          buffer = buffer.subarray(4 + l);
          const plaintext = cryptoCore.decrypt(sessionKey, frame);
          this._onControlMessage(peerDeviceId, sessionKey, socket, JSON.parse(plaintext.toString('utf8')));
        }
      };
      processRemaining();
      socket.on('data', (c) => { buffer = Buffer.concat([buffer, c]); processRemaining(); });
    });
  }

  _onControlMessage(peerDeviceId, sessionKey, socket, msg) {
    if (msg.type === 'offer') {
      const destPaths = msg.files.map((f) => `${this.receivedDir}/${f.name}`);
      this.transfers.set(msg.transferId, {
        files: msg.files,
        destPaths,
        sessionKey,
        controlSocket: socket,
        fds: destPaths.map((p) => fs.openSync(p, 'w')),
      });
      this.emit('offer', { transferId: msg.transferId, from: peerDeviceId, files: msg.files });
    }
  }

  /** Call this from the UI once the user taps "Accept". */
  acceptTransfer(transferId) {
    const t = this.transfers.get(transferId);
    if (!t) throw new Error('Unknown transfer');
    writeControlFrame(t.controlSocket, t.sessionKey, { type: 'accept', transferId });
  }

  _handleData(socket) {
    socket.once('data', (header) => {
      const transferId = bufToUuid(header.subarray(0, 16));
      const fileIndex = header.readUInt16BE(16);
      const streamIndex = header.readUInt16BE(18);
      const rest = header.subarray(20);

      const t = this.transfers.get(transferId);
      if (!t) { socket.destroy(); return; }
      const file = t.files[fileIndex];
      const ranges = byteRanges(file.size, PARALLEL_STREAMS);
      let pos = ranges[streamIndex].start;
      const fd = t.fds[fileIndex];

      const writeChunk = (buf) => {
        fs.writeSync(fd, buf, 0, buf.length, pos);
        pos += buf.length;
      };
      if (rest.length) writeChunk(rest);
      socket.on('data', writeChunk);
      socket.on('end', () => this._onStreamDone(transferId, fileIndex));
    });
  }

  _onStreamDone(transferId, fileIndex) {
    const t = this.transfers.get(transferId);
    if (!t) return;
    t._streamsDoneByFile = t._streamsDoneByFile || {};
    t._streamsDoneByFile[fileIndex] = (t._streamsDoneByFile[fileIndex] || 0) + 1;
    if (t._streamsDoneByFile[fileIndex] === PARALLEL_STREAMS) {
      fs.closeSync(t.fds[fileIndex]);
      this._maybeFinishFile(transferId);
    }
  }

  async _maybeFinishFile(transferId) {
    const t = this.transfers.get(transferId);
    if (!t) return;
    t._filesDone = (t._filesDone || 0) + 1;
    if (t._filesDone === t.files.length) {
      let ok = true;
      for (let i = 0; i < t.files.length; i++) {
        const hash = await sha256File(t.destPaths[i]);
        if (hash !== t.files[i].sha256) ok = false;
      }
      writeControlFrame(t.controlSocket, t.sessionKey, { type: 'complete', transferId, status: ok ? 'ok' : 'checksum_failed' });
      this.emit('complete', { transferId, status: ok ? 'ok' : 'checksum_failed', destPaths: t.destPaths });
      this.transfers.delete(transferId);
    }
  }

  stop() {
    if (this.controlServer) this.controlServer.close();
    for (const s of this.dataServers) s.close();
  }
}

class TransferClient {
  constructor(self, trustStore) {
    this.self = self;
    this.trustStore = trustStore;
  }

  /**
   * @param {object} peer - {deviceId, ip, transferPort}
   * @param {Array<{path:string,name:string,mime:string,isApp?:boolean,appLabel?:string,appPackage?:string}>} fileDescs
   * @returns {Promise<string>} resolves with status once receiver confirms 'complete'
   */
  async sendFiles(peer, fileDescs) {
    const sessionKey = this.trustStore.sessionKeyFor(peer.deviceId);
    if (!sessionKey) throw new Error('Cannot send: peer is not paired yet');

    const transferId = crypto.randomUUID();
    const files = await Promise.all(fileDescs.map(async (f) => ({
      name: f.name,
      size: fs.statSync(f.path).size,
      mime: f.mime,
      sha256: await sha256File(f.path),
      isApp: !!f.isApp,
      appLabel: f.appLabel,
      appPackage: f.appPackage,
    })));

    return new Promise((resolve, reject) => {
      const controlSocket = net.createConnection({ host: peer.ip, port: peer.transferPort }, () => {
        const helloPlain = Buffer.from(JSON.stringify({ type: 'hello', deviceId: this.self.deviceId }), 'utf8');
        const helloHeader = Buffer.alloc(4);
        helloHeader.writeUInt32BE(helloPlain.length, 0);
        controlSocket.write(Buffer.concat([helloHeader, helloPlain]));
        writeControlFrame(controlSocket, sessionKey, { type: 'offer', transferId, files });
      });

      controlFrameReader(controlSocket, sessionKey, async (msg) => {
        if (msg.type === 'accept' && msg.transferId === transferId) {
          await this._streamAllFiles(peer, transferId, fileDescs, files);
        }
        if (msg.type === 'complete' && msg.transferId === transferId) {
          controlSocket.end();
          resolve(msg.status);
        }
      });
      controlSocket.on('error', reject);
    });
  }

  async _streamAllFiles(peer, transferId, fileDescs, files) {
    for (let fileIndex = 0; fileIndex < fileDescs.length; fileIndex++) {
      const ranges = byteRanges(files[fileIndex].size, PARALLEL_STREAMS);
      await Promise.all(ranges.map((range, streamIndex) => new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: peer.ip, port: peer.transferPort + streamIndex + 1 }, () => {
          const header = Buffer.alloc(20);
          uuidToBuf16(transferId).copy(header, 0);
          header.writeUInt16BE(fileIndex, 16);
          header.writeUInt16BE(streamIndex, 18);
          socket.write(header);
          const readStream = fs.createReadStream(fileDescs[fileIndex].path, { start: range.start, end: range.end });
          readStream.pipe(socket);
          readStream.on('end', () => socket.end());
        });
        socket.on('error', reject);
        socket.on('close', resolve);
      })));
    }
  }
}

module.exports = { TransferServer, TransferClient, PARALLEL_STREAMS };
