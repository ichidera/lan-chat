# LAN Chat

A WhatsApp/Telegram-style chat app that works entirely over your local network —
no internet, no accounts, no server — plus built-in Xender-style file/app sharing
(Android↔Android, Android↔Desktop, Desktop↔Desktop).

See `protocol/PROTOCOL.md` first — it's the contract both clients implement, and
everything below refers back to it.

## What's here

```
lan-chat/
├── protocol/PROTOCOL.md   ← the wire format both clients speak
├── desktop/               ← Node.js + Electron client (Windows/Mac/Linux)
└── android/                ← Kotlin native Android Studio project
```

## Status: what's actually been verified vs. what's scaffolded

**Verified working, in this environment, right now:**
- `desktop/src/core/*` — discovery, pairing, encrypted chat, and parallel
  chunked file transfer. Run `npm run test:core` inside `desktop/` (or
  `node src/core/selftest.js`) to see two simulated devices pair, chat, and
  transfer a multi-megabyte file over 4 parallel streams with checksum
  verification. This is the actual protocol logic, not a mock.
- The desktop Electron app (`main.js`/`preload.js`/`renderer/`) wires that
  same core up to a real window — install deps and `npm start` to run it on
  two machines on your LAN.

**Written, protocol-accurate, but not compiled here (no Android SDK/Gradle in
this sandbox):**
- The entire `android/` Kotlin project. Every class (`Discovery.kt`,
  `ChatNode.kt`, `Transfer.kt`, `CryptoUtil.kt`, etc.) is a line-for-line
  mirror of its desktop counterpart — same JSON shapes, same byte layout for
  the encrypted frames, same chunk-header format for transfers. Open
  `android/` in Android Studio, let Gradle sync (it'll pull `com.android.tools.build`
  and Tink from Google's Maven), and build to a device. That first build/run
  on a real phone is the next milestone — Android Studio will surface any
  small API-level issues that a text-only review can't catch (e.g. an NSD or
  RandomAccessFile edge case on a specific Android version).

## Why Node's crypto + Tink, not a bigger library

Both sides use exactly one algorithm pair — X25519 for the key exchange,
ChaCha20-Poly1305 for the AEAD — sourced from each platform's own trusted
crypto library (Node's built-in `crypto`, Google's Tink for Android). No
custom cipher code, and the on-wire byte layout was deliberately chosen to
match Tink's default output format so there's zero translation logic between
platforms. See `desktop/src/core/crypto.js` and
`android/.../core/CryptoUtil.kt` for the one-paragraph comment each carries
on the pairing security model's actual limits (PIN-salted ECDH, not a full
PAKE — good enough for a v1 LAN app, called out so nobody assumes otherwise).

## Try the desktop client right now

```bash
cd desktop
npm install
npm run test:core   # proves the protocol works, no UI needed
npm start            # launches the actual Electron app
```

Run `npm start` on two machines on the same Wi-Fi/LAN, tap "+ Pair new
device" on one, copy its pairing code (PIN + device ID + public key) to the
other, and you'll see each other in "Nearby devices."

## Suggested next milestones

1. **Open `android/` in Android Studio, get it building on a real device.**
   This is the single highest-value next step — it'll validate the mirror
   implementation against real Android networking behavior (Doze mode,
   Wi-Fi multicast quirks on some OEM skins, etc.).
2. **QR-code pairing** instead of copy-pasting the JSON blob — much faster
   in person, and the payload (`deviceId` + `publicKeyRaw` + `pin`) is
   already small enough to fit in a QR comfortably.
3. **Message persistence** — SQLite on desktop (`better-sqlite3` is already
   a dependency), Room on Android — so chat history survives an app restart.
4. **Group chats** — the protocol already has `group_create` reserved in
   §6; the transport code needs a small extension to fan a message out to
   multiple peers.
5. **Transfer progress UI** — the core reports completion but not
   in-flight progress yet; wiring per-chunk progress events through to the
   UI is straightforward given the current architecture.

Happy to build out any of these next — just say which one.
