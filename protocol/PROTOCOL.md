# LAN Chat + Share — Wire Protocol v1

This document is the single source of truth. The Desktop (Node.js) client and the
Android (Kotlin) client are two independent implementations of this same spec —
that's what makes them interoperate.

All ports below are defaults and should be user-configurable (in case of conflicts).

## 1. Transports

| Purpose            | Transport | Port  |
|---------------------|-----------|-------|
| Presence/discovery  | UDP broadcast + multicast | 47110 |
| Connect (pairing request/accept) | TCP | 47120 |
| Chat messages       | TCP (JSON lines) | 47111 |
| File/app transfer   | TCP (binary framed) | 47112 (+N for parallel streams) |

Everything is LAN-scoped. Nothing ever touches the public internet — no relay,
no signaling server, no cloud component, ever.

## 2. Identity

Each device generates, once, on first launch:
- `deviceId`: random UUIDv4, persisted locally forever (this is "who you are").
- `keyPair`: Curve25519 keypair for the Noise handshake (see §5).

Identity is NOT tied to a phone number, email, or account. It's tied to the device.

## 3. Discovery (Presence)

Every device broadcasts a UDP packet every 3 seconds, using **four layers**
so it's reachable regardless of how a given machine's networking is set up:


1. Global broadcast to `255.255.255.255:47110`.
2. The subnet broadcast address computed per active network interface (e.g.
   `192.168.1.255` for a `192.168.1.0/24` Wi-Fi adapter) — this is the layer
   that matters most on machines with multiple adapters (Wi-Fi + Ethernet, a
   VPN adapter, Hyper-V/VMware virtual switches), where a single global
   broadcast can go out the wrong interface entirely.
3. Multicast to `239.255.255.250:47110` as a fallback for networks where
   broadcast is filtered but multicast isn't.
4. **Reply-on-new-peer**: the moment a device receives a presence packet from
   a `deviceId` it hasn't seen before, it immediately unicasts its own
   presence straight back to the sender's address — instead of waiting for
   its own next 3-second broadcast cycle. This fixes the common asymmetric
   case where broadcast reaches A→B fine but B→A is lossy or blocked for
   some network-specific reason: B just heard from A directly, so B can
   reply to that exact address without needing broadcast to work in that
   direction too.

There's also a **manual fallback**, "Connect by IP": a person can type
another device's IP address directly, which sends one unicast presence
packet straight to it (see `Discovery.probe()`), bypassing broadcast and
multicast entirely. Combined with layer 4 above, one working direction of
reachability is enough for both devices to discover each other.


Losing any one layer still leaves the others — this is intentionally
redundant rather than betting on "the one correct" method.

Packet shape:

```json
{
  "type": "presence",
  "deviceId": "b3f1...",
  "name": "Ada's Pixel",
  "kind": "android",         // "android" | "desktop"
  "chatPort": 47111,
  "transferPort": 47112,
  "publicKeyRaw": "9f2a...", // hex-encoded X25519 public key — see §4, this is what makes pairing PIN-only

  "version": 1,
  "ts": 1732550000
}
```

Public keys are not secret, so broadcasting one in every presence packet is
safe — it's what lets pairing (§4) skip exchanging anything but a PIN.


Receivers keep a live table of peers, keyed by `deviceId`, and expire any peer not
heard from in 12 seconds (handles someone walking out of Wi-Fi range or closing the app;
12s = 4x the announce interval, so one dropped packet doesn't flap a peer in and out).

Devices bind a UDP listener on `0.0.0.0:47110` with `SO_REUSEADDR`/`SO_BROADCAST` so
multiple instances on one dev machine can still be tested locally, and join the
multicast group on the same socket to receive layer 3 announces too.

## 4. Connect (trust, not accounts)

Before two devices can exchange chat messages or files, they must pair once.
Because public keys already travel automatically in every presence packet
(§3), pairing is reduced to the one thing that genuinely needs a human:
**agreeing on the same 6-digit PIN.**

1. Person A clicks Bob's entry in "Nearby devices." Since they're not paired
   yet, this opens a pairing dialog showing a freshly generated PIN.
2. Person A tells Bob that PIN (out loud, over text, however — this is the
   one out-of-band step).
3. Bob clicks Alice's entry on his device. His pairing dialog also generates
   its own PIN by default, but he overwrites it with the PIN Alice gave him.
4. Both sides derive a session key from `(their own private key, the peer's
   already-known public key, the shared PIN)` — see `deriveSessionKey` in
   `crypto.js`/`CryptoUtil.kt`. This is a pure local computation; nothing is
   sent back and forth to "confirm" a match. If both people used the same
   PIN, every future encrypted message between them decrypts correctly. If
   they used different PINs, decryption fails loudly (AEAD authentication
   failure) rather than silently producing garbage — so a mismatched PIN is
   very obvious the first time you try to chat, not a subtle bug.
5. Each side stores the peer's `deviceId` + `publicKeyRaw` + derived session
   key in a local "trusted peers" store. No PIN needed again after this.

Untrusted peers are visible in "Nearby Devices" (so you can see who's
around) but clicking one opens the pairing dialog instead of a chat, until
paired.

**Threat model note:** this is a PIN-salted ECDH, not a full PAKE (e.g.
SPAKE2). It stops a passive network observer who didn't see the PIN. It's
intentionally simple for a v1 LAN app.


## 5. Transport Security

Once connected (§4), every TCP connection (chat AND transfer control channel)
is wrapped in AES-256-GCM using the session key derived at connect time.
Every encrypted frame is `[12-byte nonce][ciphertext][16-byte tag]` — chosen
to match Google Tink's AEAD subtle-primitive output byte-for-byte, so the
Android (Tink) and desktop (Node's built-in `crypto`) implementations need
zero translation logic between them. No plaintext ever hits the wire once
connected. This used to use ChaCha20-Poly1305; that was switched to
AES-256-GCM after finding it's not available in some Windows Electron
builds' bundled OpenSSL ("Unknown cipher"). AES-GCM is mandated by TLS
itself, so it's guaranteed present everywhere Node/Electron/Android run.

## 6. Chat Protocol (TCP, port 47111)

Newline-delimited JSON, one object per line, over the Noise-encrypted socket.

```json
{"type":"msg","id":"uuid","from":"deviceId","to":"deviceId|groupId","body":"hello","ts":1732550000}
{"type":"ack","id":"uuid","status":"delivered"}
{"type":"typing","from":"deviceId","to":"deviceId","state":true}
{"type":"group_create","id":"groupId","name":"Team","members":["id1","id2"]}
```

- Messages queue locally if the peer is offline and flush on next `presence` sighting
  of that `deviceId` (store-and-forward on the sender's own device only — no server
  buffering, since there is no server).
- Every device keeps a local SQLite (desktop) / Room (Android) DB of message history,
  keyed by conversation. Nothing leaves the device.

## 7. Transfer Protocol (TCP, port 47112) — the "Xender" part

Separate connection from chat, so a big transfer never blocks message delivery.

**Step 1 — Offer (small JSON, on the transfer port):**
```json
{
  "type":"offer",
  "transferId":"uuid",
  "from":"deviceId",
  "files":[
    {"name":"holiday.jpg","size":4213112,"mime":"image/jpeg","sha256":"..."},
    {"name":"MyApp.apk","size":18213299,"mime":"application/vnd.android.package-archive","sha256":"...","isApp":true,"appLabel":"My App","appPackage":"com.example.myapp"}
  ]
}
```

**Step 2 — Accept/Reject (receiver → sender):**
```json
{"type":"accept","transferId":"uuid"}
```

**Step 3 — Parallel chunk streams.** Sender opens N parallel TCP connections
(default N=4, tuned by LAN throughput) to `transferPort..transferPort+N-1`. Each
file is split into 1 MiB chunks; chunks are striped round-robin across the N
connections so one slow stream doesn't stall the whole transfer.

Each chunk frame (binary):
```
[4 bytes: transferId index][4 bytes: chunk index][4 bytes: chunk length][chunk length bytes: data][4 bytes: CRC32]
```

**Step 4 — Completion.** Receiver verifies each file's sha256 once all chunks land,
sends:
```json
{"type":"complete","transferId":"uuid","status":"ok"}
```
If a stream drops mid-transfer, receiver reports which chunk indices are missing and
sender resumes just those — no restart from zero.

## 8. The APK-Sharing Wrinkle (Android specific)

- **Sending an installed app** (Android → anywhere): read the APK bytes from
  `applicationInfo.sourceDir` via `PackageManager`, treat it as a normal file with
  `isApp:true` + `appLabel` + `appPackage` metadata so the receiving UI can render
  it as an app card, not a generic file.
- **Receiving on Android**: land bytes in `cacheDir`, then launch
  `Intent(ACTION_VIEW)` on a `FileProvider` URI with
  `REQUEST_INSTALL_PACKAGES` permission granted at pairing time (one-time system
  prompt, same as any sideload tool).
- **Receiving on Desktop**: it's just a file. Save to a configurable "LAN Chat
  Received" folder. No install step (nothing to install on desktop).

## 9. Versioning

`version` field in the presence packet lets both clients refuse/warn on protocol
mismatch instead of silently breaking.
