'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lanchat', {
  getSelf: () => ipcRenderer.invoke('self:get'),
  listPeers: () => ipcRenderer.invoke('peers:list'),
  listTrusted: () => ipcRenderer.invoke('trust:list'),
  getSelfAddresses: () => ipcRenderer.invoke('network:selfAddresses'),

  // Connect flow: click to initiate, popup to accept — see pairing.js
  initiateConnect: (peer) => ipcRenderer.invoke('connect:initiate', { peer }),
  respondToConnect: (requestId, accept) => ipcRenderer.invoke('connect:respond', { requestId, accept }),
  onIncomingConnect: (cb) => ipcRenderer.on('connect:incoming', (_e, data) => cb(data)),
  onConnectWaiting: (cb) => ipcRenderer.on('connect:waiting', (_e, data) => cb(data)),

  probeIp: (ip) => ipcRenderer.invoke('discovery:probeIp', { ip }),

  sendChat: (peer, body) => ipcRenderer.invoke('chat:send', { peer, body }),
  onChatMessage: (cb) => ipcRenderer.on('chat:message', (_e, data) => cb(data)),
  onPeersUpdate: (cb) => ipcRenderer.on('peers:update', (_e, peers) => cb(peers)),

  acceptTransfer: (transferId) => ipcRenderer.invoke('transfer:accept', { transferId }),
  sendFiles: (peer) => ipcRenderer.invoke('transfer:sendFiles', { peer }),
  onTransferOffer: (cb) => ipcRenderer.on('transfer:offer', (_e, data) => cb(data)),
  onTransferComplete: (cb) => ipcRenderer.on('transfer:complete', (_e, data) => cb(data)),
});
