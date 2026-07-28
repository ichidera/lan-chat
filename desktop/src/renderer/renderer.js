'use strict';

let peers = [];
let trustedIds = new Set();
let activePeer = null;
let myPairingOffer = null;

const el = (id) => document.getElementById(id);

async function refreshSelf() {
  const self = await window.lanchat.getSelf();
  el('self-name').textContent = `${self.name}`;
}

async function refreshTrusted() {
  const trusted = await window.lanchat.listTrusted();
  trustedIds = new Set(trusted.map((t) => t.deviceId));
}

function renderPeerList() {
  const ul = el('peer-list');
  ul.innerHTML = '';
  for (const peer of peers) {
    const li = document.createElement('li');
    li.className = 'peer' + (trustedIds.has(peer.deviceId) ? ' trusted' : ' untrusted');
    li.textContent = `${peer.kind === 'android' ? '📱' : '💻'} ${peer.name}` + (trustedIds.has(peer.deviceId) ? '' : ' (not paired)');
    li.onclick = () => selectPeer(peer);
    ul.appendChild(li);
  }
}

function selectPeer(peer) {
  if (!trustedIds.has(peer.deviceId)) {
    alert('Pair with this device first (see "+ Pair new device").');
    return;
  }
  activePeer = peer;
  el('chat-header').textContent = `Chat with ${peer.name}`;
  el('msg-input').disabled = false;
  el('send-btn').disabled = false;
  el('file-btn').disabled = false;
  el('messages').innerHTML = '';
}

function appendMessage(text, fromMe) {
  const div = document.createElement('div');
  div.className = 'msg ' + (fromMe ? 'from-me' : 'from-them');
  div.textContent = text;
  el('messages').appendChild(div);
  el('messages').scrollTop = el('messages').scrollHeight;
}

el('send-btn').onclick = async () => {
  const text = el('msg-input').value.trim();
  if (!text || !activePeer) return;
  await window.lanchat.sendChat(activePeer, text);
  appendMessage(text, true);
  el('msg-input').value = '';
};
el('msg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('send-btn').click(); });

el('file-btn').onclick = async () => {
  if (!activePeer) return;
  el('file-btn').textContent = '⏳';
  try {
    const status = await window.lanchat.sendFiles(activePeer);
    if (status) appendMessage(`[file sent — ${status}]`, true);
  } finally {
    el('file-btn').textContent = '📎';
  }
};

el('pair-btn').onclick = async () => {
  myPairingOffer = await window.lanchat.startPairing();
  el('pairing-pin').textContent = myPairingOffer.pin;
  el('pairing-modal').classList.remove('hidden');
};
el('close-pairing-btn').onclick = () => el('pairing-modal').classList.add('hidden');

el('complete-pairing-btn').onclick = async () => {
  try {
    const offer = JSON.parse(el('their-device-json').value);
    await window.lanchat.completePairing(offer);
    await refreshTrusted();
    renderPeerList();
    el('pairing-modal').classList.add('hidden');
  } catch (e) {
    alert('Could not parse pairing code: ' + e.message);
  }
};

window.lanchat.onPeersUpdate((updated) => { peers = updated; renderPeerList(); });
window.lanchat.onChatMessage(({ from, msg }) => {
  if (activePeer && from === activePeer.deviceId) appendMessage(msg.body, false);
});
window.lanchat.onTransferOffer(async ({ transferId, from, files }) => {
  const names = files.map((f) => f.name).join(', ');
  if (confirm(`Incoming file(s) from a paired device: ${names}. Accept?`)) {
    await window.lanchat.acceptTransfer(transferId);
  }
});
window.lanchat.onTransferComplete(({ status, destPaths }) => {
  el('transfer-toast').textContent = `Received: ${destPaths.join(', ')} (${status})`;
  el('transfer-toast').classList.remove('hidden');
  setTimeout(() => el('transfer-toast').classList.add('hidden'), 4000);
});

setInterval(async () => {
  peers = await window.lanchat.listPeers();
  renderPeerList();
}, 3000);

refreshSelf();
refreshTrusted().then(() => window.lanchat.listPeers().then((p) => { peers = p; renderPeerList(); }));
