# LAN Chat + Share — Wire Protocol v1

This document is the single source of truth. The Desktop (Node.js) client and the
Android (Kotlin) client are two independent implementations of this same spec —
that's what makes them interoperate.

All ports below are defaults and should be user-configurable (in case of conflicts).

## 1. Transports

| Purpose            | Transport | Port  |
|---------------------|-----------|-------|
| Presence/discovery  | UDP broadcast | 47110 |
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

Every device broadcasts a UDP packet every 3 seconds to `255.255.255.255:47110`:

```json
{
  "type": "presence",
  "deviceId": "b3f1...",
  "name": "Ada's Pixel",
  "kind": "android" ,        // "android" | "desktop"
  "chatPort": 47111,
  "transferPort": 47112,
  "version": 1,
  "ts": 1732550000
}
```

Receivers keep a live table of peers, keyed by `deviceId`, and expire any peer not
heard from in 10 seconds (handles someone walking out of Wi-Fi range or closing the app).

Devices bind a UDP listener on `0.0.0.0:47110` with `SO_REUSEADDR`/`SO_BROADCAST` so
multiple instances on one dev machine can still be tested locally.

## 4. Pairing (trust, not accounts)

Before two devices can exchange chat messages or files, they must pair once:

1. Device A shows a **6-digit PIN** (or QR code encoding the same payload) generated
   locally: `{deviceId, pubKey, pin}`.
2. Device B scans/enters it. Both sides run a Noise "NN"-style handshake seeded with
   the PIN as an out-of-band authenticator (SPAKE2-style: prevents a third LAN device
   from silently MITM'ing the handshake).
3. On success, each side stores the other's `deviceId` + `pubKey` in a local
   "trusted peers" store. All future messages from that `deviceId` are authenticated
   against that stored public key — no PIN needed again.

Untrusted peers are visible in the "Nearby Devices" list (so you can see who's
around) but chat/transfer actions are disabled until paired.

## 5. Transport Security

Once paired, every TCP connection (chat AND transfer) is wrapped in a
**Noise_XX**-authenticated encrypted channel using the stored keypairs. No plaintext
ever hits the wire. This is deliberately simple crypto (one library, one pattern) —
not rolling anything custom.

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
