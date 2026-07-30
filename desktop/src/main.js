'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const { Discovery } = require('./core/discovery');
const { TrustStore } = require('./core/trustStore');
const { generatePin, pairWithPeer } = require('./core/pairing');

const cryptoCore = require('./core/crypto');
const { ChatNode } = require('./core/chat');
const { TransferServer, TransferClient } = require('./core/transfer');

const APP_DIR = path.join(os.homedir(), '.lan-chat');
const RECEIVED_DIR = path.join(APP_DIR, 'received');
const IDENTITY_FILE = path.join(APP_DIR, 'identity.json');

function loadOrCreateIdentity() {
  fs.mkdirSync(APP_DIR, { recursive: true });
  if (fs.existsSync(IDENTITY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    const keyPair = {
      publicKey: crypto.createPublicKey({ key: Buffer.from(raw.publicKeyDer, 'hex'), format: 'der', type: 'spki' }),
      privateKey: crypto.createPrivateKey({ key: Buffer.from(raw.privateKeyDer, 'hex'), format: 'der', type: 'pkcs8' }),
    };
    return { deviceId: raw.deviceId, name: raw.name, keyPair };
  }
  const keyPair = cryptoCore.generateKeyPair();
  const identity = {
    deviceId: crypto.randomUUID(),
    name: `${os.hostname()}`,
    publicKeyDer: keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKeyDer: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2));
  return { deviceId: identity.deviceId, name: identity.name, keyPair };
}

let mainWindow;
let self;
let discovery, trustStore, chat, transferServer, transferClient, connectServer, connectClient;
const pendingIncomingConnects = new Map(); // requestId -> respond(accept: boolean)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const identity = loadOrCreateIdentity();
  const publicKeyRaw = cryptoCore.exportPublicKeyRaw(identity.keyPair.publicKey).toString('hex');
  self = { ...identity, chatPort: 47111, transferPort: 47112, publicKeyRaw };


  trustStore = new TrustStore(path.join(APP_DIR, 'trust.json'));

  discovery = new Discovery(self);
  discovery.on('peer:new', () => mainWindow.webContents.send('peers:update', discovery.list()));
  discovery.on('peer:update', () => mainWindow.webContents.send('peers:update', discovery.list()));
  discovery.on('peer:gone', () => mainWindow.webContents.send('peers:update', discovery.list()));
  discovery.on('error', (err) => console.warn('[discovery]', err.message));
  discovery.start();

  chat = new ChatNode(self, trustStore);
  chat.on('message', ({ from, msg }) => mainWindow.webContents.send('chat:message', { from, msg }));
  chat.start();

  transferServer = new TransferServer(self, trustStore, RECEIVED_DIR);
  transferServer.on('offer', (offer) => mainWindow.webContents.send('transfer:offer', offer));
  transferServer.on('complete', (info) => mainWindow.webContents.send('transfer:complete', info));
  transferServer.start();

  transferClient = new TransferClient(self, trustStore);

  connectServer = new ConnectServer(self, trustStore);
  connectServer.on('incoming', (req) => {
    const requestId = crypto.randomUUID();
    pendingIncomingConnects.set(requestId, req.respond);
    mainWindow.webContents.send('connect:incoming', { requestId, deviceId: req.deviceId, name: req.name, code: req.code });
  });
  connectServer.start();
  connectClient = new ConnectClient(self, trustStore);

  createWindow();
});

// ---- IPC bridge: renderer never touches Node/network directly ----

ipcMain.handle('self:get', () => ({ deviceId: self.deviceId, name: self.name }));
ipcMain.handle('peers:list', () => discovery.list());
ipcMain.handle('trust:list', () => trustStore.list());

ipcMain.handle('pairing:generatePin', () => generatePin());
ipcMain.handle('pairing:pair', (_e, { peer, pin }) => {
  pairWithPeer(self, peer, pin, trustStore); // throws with a friendly message on bad PIN / missing pubkey — renderer shows it
  return true;
});

  return true;
});

ipcMain.handle('discovery:probeIp', (_e, { ip }) => {
  discovery.probe(ip);
  return true;
});

ipcMain.handle('network:selfAddresses', () => {
  const addrs = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
});

ipcMain.handle('chat:send', async (_e, { peer, body }) => {
  const msg = { type: 'msg', id: crypto.randomUUID(), from: self.deviceId, to: peer.deviceId, body, ts: Date.now() };
  await chat.send(peer, msg);
  return msg;
});

ipcMain.handle('transfer:accept', (_e, { transferId }) => {
  transferServer.acceptTransfer(transferId);
  return true;
});

ipcMain.handle('transfer:sendFiles', async (_e, { peer }) => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  if (result.canceled) return null;
  const fileDescs = result.filePaths.map((p) => ({
    path: p,
    name: path.basename(p),
    mime: 'application/octet-stream',
  }));
  return transferClient.sendFiles(peer, fileDescs);
});

app.on('window-all-closed', () => {
  discovery?.stop();
  chat?.stop();
  transferServer?.stop();
  connectServer?.stop();
  if (process.platform !== 'darwin') app.quit();
});
