'use strict';

let peers = [];
let trustedIds = new Set();
let activePeer = null;      // peer currently open in the chat panel (or null)
let pairingPeer = null;     // peer the pairing modal is currently open for


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
    li.textContent = `${peer.kind === 'android' ? '📱' : '💻'} ${peer.name}` + (isTrusted ? '' : ' — tap to pair');

    li.onclick = () => togglePeer(peer);
    ul.appendChild(li);
  }
}

/** Clicking a device in "Nearby devices" is the single entry point: pair if
 * needed, open its chat if not currently open, or close the chat if you
 * click the same (already-open) device again. */
function togglePeer(peer) {
  if (!trustedIds.has(peer.deviceId)) {
    openPairingModal(peer);
    return;
  }
  if (activePeer && activePeer.deviceId === peer.deviceId) {
    // clicking the currently-open conversation again closes it

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
  el('chat-header').textContent = 'Click a device on the left to chat, or to pair with it';

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

// ---- Pairing (per-peer, PIN only) ----

async function openPairingModal(peer) {
  pairingPeer = peer;
  el('pairing-title').textContent = `Pair with ${peer.name}`;
  el('pairing-error').classList.add('hidden');
  el('pin-input').value = '';
  const pin = await window.lanchat.generatePairingPin();
  el('pairing-pin').textContent = pin;
  el('pairing-modal').classList.remove('hidden');
}

el('close-pairing-btn').onclick = () => {
  el('pairing-modal').classList.add('hidden');
  pairingPeer = null;
};

el('complete-pairing-btn').onclick = async () => {
  if (!pairingPeer) return;
  const typedPin = el('pin-input').value.trim();
  const generatedPin = el('pairing-pin').textContent.trim();
  const pin = typedPin || generatedPin; // prefer a PIN they typed in (Option B); fall back to the one we generated (Option A)

  // Always use the freshest known copy of this peer (it may have gained a
  // publicKeyRaw since the modal opened, if its app only just started).
  const livePeer = peers.find((p) => p.deviceId === pairingPeer.deviceId) || pairingPeer;

  try {
    await window.lanchat.pairWithPeer(livePeer, pin);
    await refreshTrusted();
    renderPeerList();
    el('pairing-modal').classList.add('hidden');
    pairingPeer = null;
    openChat(livePeer);
  } catch (e) {
    el('pairing-error').textContent = e.message.replace(/^Error invoking remote method '.*?': Error: /, '');
    el('pairing-error').classList.remove('hidden');
  }
};

  }
}

el('cancel-waiting-btn').onclick = () => {
  // Note: this only hides the dialog: the underlying request may still
  // resolve shortly after (accept/reject/timeout) — refreshTrusted() on the
  // next peer list poll will pick up an acceptance either way.
  el('waiting-modal').classList.add('hidden');
  waitingPeer = null;
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
