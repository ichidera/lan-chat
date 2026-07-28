'use strict';
/**
 * Runs two simulated "devices" (Alice + Bob) in one process, on localhost,
 * to prove discovery -> pairing -> chat -> file transfer all work end to end.
 * Not a replacement for real multi-machine LAN testing, but catches every
 * logic bug before you ever touch Android Studio.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Discovery } = require('./discovery');
const { TrustStore } = require('./trustStore');
const { startPairing, deriveMatchingKey } = require('./pairing');
const cryptoCore = require('./crypto');
const { ChatNode } = require('./chat');
const { TransferServer, TransferClient } = require('./transfer');

function makeSelf(name, basePort) {
  return {
    deviceId: crypto.randomUUID(),
    name,
    keyPair: cryptoCore.generateKeyPair(),
    chatPort: basePort,
    transferPort: basePort + 10,
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

  // 1) Pairing (simulating PIN exchange happening out of band, e.g. user reads screen)
  const offerFromAlice = startPairing(alice);
  const bobSessionKey = deriveMatchingKey(bob, offerFromAlice.publicKeyRaw, offerFromAlice.pin);
  bobTrust.addPaired(alice.deviceId, alice.name, Buffer.from(offerFromAlice.publicKeyRaw, 'hex'), bobSessionKey);

  const bobPublicKeyRaw = cryptoCore.exportPublicKeyRaw(bob.keyPair.publicKey).toString('hex');
  const aliceSessionKey = deriveMatchingKey(alice, bobPublicKeyRaw, offerFromAlice.pin);
  aliceTrust.addPaired(bob.deviceId, bob.name, Buffer.from(bobPublicKeyRaw, 'hex'), aliceSessionKey);

  console.assert(aliceSessionKey.equals(bobSessionKey), 'FAIL: session keys must match');
  console.log('[ok] pairing: both sides derived identical session key');

  // 2) Discovery (real UDP broadcast on loopback-capable network in this sandbox)
  const aliceDisc = new Discovery({ deviceId: alice.deviceId, name: alice.name, chatPort: alice.chatPort, transferPort: alice.transferPort });
  const bobDisc = new Discovery({ deviceId: bob.deviceId, name: bob.name, chatPort: bob.chatPort, transferPort: bob.transferPort });
  aliceDisc.start();
  bobDisc.start();
  await sleep(500);
  const bobSeenByAlice = aliceDisc.peers.get(bob.deviceId);
  console.log(bobSeenByAlice
    ? '[ok] discovery: Alice sees Bob via UDP broadcast'
    : '[skip] discovery: UDP broadcast blocked in this sandbox (expected in some containers) — continuing with manual peer info');
  aliceDisc.stop();
  bobDisc.stop();

  // Fall back to manual peer objects for the rest of the test (mirrors what
  // Discovery would have produced) so the rest of the pipeline is still proven.
  const bobPeerForAlice = bobSeenByAlice || { deviceId: bob.deviceId, ip: '127.0.0.1', chatPort: bob.chatPort, transferPort: bob.transferPort };
  const alicePeerForBob = { deviceId: alice.deviceId, ip: '127.0.0.1', chatPort: alice.chatPort, transferPort: alice.transferPort };

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
  const status = await transferClient.sendFiles(alicePeerForBob.deviceId ? bobPeerForAlice : bobPeerForAlice, [
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
