'use strict';

let peers = [];
let trustedIds = new Set();
let activePeer = null;   // peer currently open in the chat panel (or null)
let waitingPeer = null;  // peer we're currently waiting on a connect response from

const el = (id) => document.getElementById(id);

async function refreshSelf() {
  const self = await window.lanchat.getSelf();
  el('self-name').textContent = self.name;
  const addrs = await window.lanchat.getSelfAddresses();
  el('self-ip').textContent = addrs.length ? `Your IP: ${addrs.join(', ')}` : '';
}

async function refreshTrusted() {
  const trusted = await window.lanchat.listTrusted();
  trustedIds = new Set(trusted.map((t) => t.deviceId));
}

function renderPeerList() {
  const ul = el('peer-list');
  ul.innerHTML = '';
  el('empty-hint').classList.toggle('hidden', peers.length > 0);

  for (const peer of peers) {
    const li = document.createElement('li');
    const isTrusted = trustedIds.has(peer.deviceId);
    const isActive = activePeer && activePeer.deviceId === peer.deviceId;
    li.className = 'peer' + (isTrusted ? ' trusted' : ' untrusted') + (isActive ? ' active' : '');
    li.textContent = `${peer.kind === 'android' ? '📱' : '💻'} ${peer.name}` + (isTrusted ? '' : ' — click to connect');
    li.onclick = () => togglePeer(peer);
    ul.appendChild(li);
  }
}

/** Clicking a device is the single entry point: start a Connect request if
 *  not paired, otherwise open/close its chat. */
function togglePeer(peer) {
  if (!trustedIds.has(peer.deviceId)) {
    startConnect(peer);
    return;
  }
  if (activePeer && activePeer.deviceId === peer.deviceId) {
    closeChat();
  } else {
    openChat(peer);
  }
}

function openChat(peer) {
  activePeer = peer;
  el('chat-header').textContent = `Chat with ${peer.name}`;
  el('msg-input').disabled = false;
  el('send-btn').disabled = false;
  el('file-btn').disabled = false;
  el('messages').innerHTML = '';
  renderPeerList();
}

function closeChat() {
  activePeer = null;
  el('chat-header').textContent = 'Click a device on the left to connect, or to chat';
  el('msg-input').disabled = true;
  el('send-btn').disabled = true;
  el('file-btn').disabled = true;
  el('messages').innerHTML = '';
  renderPeerList();
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

// ---- Connect flow (Bluetooth-style: ask, then the other side accepts) ----

async function startConnect(peer) {
  if (!confirm(`Connect to ${peer.name}?`)) return;

  waitingPeer = peer;
  el('waiting-title').textContent = `Connecting to ${peer.name}…`;
  el('waiting-code').textContent = '------';
  el('waiting-modal').classList.remove('hidden');

  try {
    const result = await window.lanchat.initiateConnect(peer);
    el('waiting-modal').classList.add('hidden');
    waitingPeer = null;

    if (result.status === 'accepted') {
      await refreshTrusted();
      renderPeerList();
      openChat(peer);
    } else if (result.status === 'rejected') {
      alert(`${peer.name} declined the connection request.`);
    } else if (result.status === 'timeout') {
      alert(`${peer.name} didn't respond in time. Make sure their app is open and try again.`);
    }
  } catch (e) {
    el('waiting-modal').classList.add('hidden');
    waitingPeer = null;
    alert(`Couldn't connect: ${e.message}`);
  }
}

el('cancel-waiting-btn').onclick = () => {
  // Note: this only hides the dialog: the underlying request may still
  // resolve shortly after (accept/reject/timeout) — refreshTrusted() on the
  // next peer list poll will pick up an acceptance either way.
  el('waiting-modal').classList.add('hidden');
  waitingPeer = null;
};

window.lanchat.onConnectWaiting(({ deviceId, code }) => {
  if (waitingPeer && waitingPeer.deviceId === deviceId) {
    el('waiting-code').textContent = code;
  }
});

let currentIncomingRequestId = null;
window.lanchat.onIncomingConnect(({ requestId, name, code }) => {
  currentIncomingRequestId = requestId;
  el('incoming-body').textContent = `${name} wants to connect.`;
  el('incoming-code').textContent = code;
  el('incoming-modal').classList.remove('hidden');
});

el('incoming-accept-btn').onclick = async () => {
  if (!currentIncomingRequestId) return;
  await window.lanchat.respondToConnect(currentIncomingRequestId, true);
  el('incoming-modal').classList.add('hidden');
  currentIncomingRequestId = null;
  await refreshTrusted();
  renderPeerList();
};
el('incoming-decline-btn').onclick = async () => {
  if (!currentIncomingRequestId) return;
  await window.lanchat.respondToConnect(currentIncomingRequestId, false);
  el('incoming-modal').classList.add('hidden');
  currentIncomingRequestId = null;
};

// ---- Manual "Connect by IP" (bypasses broadcast entirely) ----

el('manual-ip-btn').onclick = async () => {
  const ip = el('manual-ip-input').value.trim();
  if (!ip) return;
  await window.lanchat.probeIp(ip);
  el('manual-ip-input').value = '';
  el('transfer-toast').textContent = `Probing ${ip} — it should appear in Nearby devices in a moment if reachable.`;
  el('transfer-toast').classList.remove('hidden');
  setTimeout(() => el('transfer-toast').classList.add('hidden'), 4000);
};

// ---- Live updates from main process ----

window.lanchat.onPeersUpdate((updated) => {
  peers = updated;
  renderPeerList();
  if (activePeer) {
    const fresh = peers.find((p) => p.deviceId === activePeer.deviceId);
    if (fresh) activePeer = fresh; // keep IP/ports current if the peer's address changed
  }
});

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
