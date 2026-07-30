'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lanchat', {
  getSelf: () => ipcRenderer.invoke('self:get'),
  listPeers: () => ipcRenderer.invoke('peers:list'),
  listTrusted: () => ipcRenderer.invoke('trust:list'),
  getSelfAddresses: () => ipcRenderer.invoke('network:selfAddresses'),

  generatePairingPin: () => ipcRenderer.invoke('pairing:generatePin'),
  pairWithPeer: (peer, pin) => ipcRenderer.invoke('pairing:pair', { peer, pin }),
  probeIp: (ip) => ipcRenderer.invoke('discovery:probeIp', { ip }),


  sendChat: (peer, body) => ipcRenderer.invoke('chat:send', { peer, body }),
  onChatMessage: (cb) => ipcRenderer.on('chat:message', (_e, data) => cb(data)),
  onPeersUpdate: (cb) => ipcRenderer.on('peers:update', (_e, peers) => cb(peers)),

  acceptTransfer: (transferId) => ipcRenderer.invoke('transfer:accept', { transferId }),
  sendFiles: (peer) => ipcRenderer.invoke('transfer:sendFiles', { peer }),
  onTransferOffer: (cb) => ipcRenderer.on('transfer:offer', (_e, data) => cb(data)),
  onTransferComplete: (cb) => ipcRenderer.on('transfer:complete', (_e, data) => cb(data)),
});
