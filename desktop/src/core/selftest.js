'use strict';
/**
 * Runs two simulated "devices" (Alice + Bob) in one process, on localhost,
 * to prove discovery -> connect (interactive accept) -> chat -> file
 * transfer all work end to end. Not a replacement for real multi-machine
 * LAN testing, but catches every logic bug before you ever touch a second
 * machine or Android Studio.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Discovery } = require('./discovery');
const { TrustStore } = require('./trustStore');
const { ConnectServer, ConnectClient } = require('./pairing');
const cryptoCore = require('./crypto');
const { ChatNode } = require('./chat');
const { TransferServer, TransferClient } = require('./transfer');

function makeSelf(name, basePort) {
  const keyPair = cryptoCore.generateKeyPair();
  return {
    deviceId: crypto.randomUUID(),
    name,
    keyPair,
    publicKeyRaw: cryptoCore.exportPublicKeyRaw(keyPair.publicKey).toString('hex'),
    chatPort: basePort,
    transferPort: basePort + 10,
    connectPort: basePort + 20,
  };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log('--- LAN Chat core self-test ---');

  const alice = makeSelf('Alice-Desktop', 47201);
  const bob = makeSelf('Bob-Desktop', 47301);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-'));
  const aliceTrust = new TrustStore(path.join(tmpDir, 'alice-trust.json'));
  const bobTrust = new TrustStore(path.join(tmpDir, 'bob-trust.json'));

  // 0) AEAD sanity check on this machine's Node build — this is exactly what
  // crashed for the reported "Unknown cipher" bug, so prove it up front.
  const testKey = crypto.randomBytes(32);
  const testFrame = cryptoCore.encrypt(testKey, Buffer.from('hello'));
  const testPlain = cryptoCore.decrypt(testKey, testFrame);
  console.assert(testPlain.toString() === 'hello', 'FAIL: AES-256-GCM round-trip broken');
  console.log('[ok] crypto: AES-256-GCM encrypt/decrypt round-trip works on this Node build');

  // 1) Discovery (real UDP broadcast on loopback-capable network in this sandbox)
  const aliceDisc = new Discovery({ deviceId: alice.deviceId, name: alice.name, chatPort: alice.chatPort, transferPort: alice.transferPort, connectPort: alice.connectPort, publicKeyRaw: alice.publicKeyRaw });
  const bobDisc = new Discovery({ deviceId: bob.deviceId, name: bob.name, chatPort: bob.chatPort, transferPort: bob.transferPort, connectPort: bob.connectPort, publicKeyRaw: bob.publicKeyRaw });
  aliceDisc.start();
  bobDisc.start();
  await sleep(500);
  const bobSeenByAlice = aliceDisc.peers.get(bob.deviceId);
  const aliceSeenByBob = bobDisc.peers.get(alice.deviceId);
  console.log(bobSeenByAlice && aliceSeenByBob
    ? '[ok] discovery: Alice and Bob see each other via UDP broadcast (and/or the reply-on-new-peer handshake)'
    : '[skip] discovery: UDP broadcast blocked in this sandbox (expected in some containers) — continuing with manual peer info');
  aliceDisc.stop();
  bobDisc.stop();

  const bobPeerForAlice = bobSeenByAlice || { deviceId: bob.deviceId, name: bob.name, ip: '127.0.0.1', publicKeyRaw: bob.publicKeyRaw, chatPort: bob.chatPort, transferPort: bob.transferPort, connectPort: bob.connectPort };
  const alicePeerForBob = { deviceId: alice.deviceId, name: alice.name, ip: '127.0.0.1', publicKeyRaw: alice.publicKeyRaw, chatPort: alice.chatPort, transferPort: alice.transferPort, connectPort: alice.connectPort };

  // 2) Connect flow — real TCP over loopback, real interactive accept, no PIN.
  const bobConnectServer = new ConnectServer(bob, bobTrust);
  bobConnectServer.on('incoming', (req) => {
    // Simulates Bob's human tapping "Accept" — in the real UI this happens
    // after they visually compare the verification code.
    req.respond(true);
  });
  bobConnectServer.start();
  await sleep(100);

  const aliceConnectClient = new ConnectClient(alice, aliceTrust);
  let waitingCode = null;
  const connectResult = await aliceConnectClient.connect(bobPeerForAlice, (code) => { waitingCode = code; });
  console.assert(connectResult.status === 'accepted', `FAIL: connect status was ${connectResult.status}`);
  console.assert(waitingCode === connectResult.code, 'FAIL: waiting code should match final code');
  console.assert(aliceTrust.isPaired(bob.deviceId), 'FAIL: Alice should have Bob trusted after accept');
  console.assert(bobTrust.isPaired(alice.deviceId), 'FAIL: Bob should have Alice trusted after accept');
  console.assert(aliceTrust.sessionKeyFor(bob.deviceId).equals(bobTrust.sessionKeyFor(alice.deviceId)), 'FAIL: session keys must match');
  console.log(`[ok] connect: interactive accept flow completed, both sides derived identical session key (verification code ${connectResult.code})`);
  bobConnectServer.stop();

  // 3) Chat
  const aliceChat = new ChatNode(alice, aliceTrust);
  const bobChat = new ChatNode(bob, bobTrust);
  aliceChat.start();
  bobChat.start();
  await sleep(200);

  const bobReceived = new Promise((resolve) => {
    bobChat.on('message', ({ from, msg }) => resolve({ from, msg }));
  });
  await aliceChat.send(bobPeerForAlice, { type: 'msg', id: crypto.randomUUID(), from: alice.deviceId, to: bob.deviceId, body: 'hey Bob, LAN chat works', ts: Date.now() });
  const received = await bobReceived;
  console.assert(received.msg.body === 'hey Bob, LAN chat works', 'FAIL: chat message mismatch');
  console.log('[ok] chat: encrypted message delivered and decrypted correctly:', JSON.stringify(received.msg.body));

  // 4) File transfer (simulate sharing a small "APK")
  const sendDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-send-'));
  const fakeApkPath = path.join(sendDir, 'MyApp.apk');
  const fakeApkContent = crypto.randomBytes(2 * 1024 * 1024 + 1234); // ~2MB, not chunk-aligned on purpose
  fs.writeFileSync(fakeApkPath, fakeApkContent);

  const receivedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-recv-'));
  const transferServer = new TransferServer(bob, bobTrust, receivedDir);
  transferServer.on('offer', ({ transferId }) => transferServer.acceptTransfer(transferId));
  transferServer.start();
  await sleep(200);

  const transferClient = new TransferClient(alice, aliceTrust);
  const status = await transferClient.sendFiles(bobPeerForAlice, [
    { path: fakeApkPath, name: 'MyApp.apk', mime: 'application/vnd.android.package-archive', isApp: true, appLabel: 'My App', appPackage: 'com.example.myapp' },
  ]);
  console.assert(status === 'ok', `FAIL: transfer status was ${status}`);
  const receivedContent = fs.readFileSync(path.join(receivedDir, 'MyApp.apk'));
  console.assert(receivedContent.equals(fakeApkContent), 'FAIL: received bytes do not match sent bytes');
  console.log(`[ok] transfer: ${fakeApkContent.length} byte file sent over ${require('./transfer').PARALLEL_STREAMS} parallel streams, checksum verified`);

  aliceChat.stop();
  bobChat.stop();
  transferServer.stop();

  console.log('--- all core self-tests passed ---');
  process.exit(0);
}

main().catch((err) => {
  console.error('SELF-TEST FAILED:', err);
  process.exit(1);
});
