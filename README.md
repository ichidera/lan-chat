# LAN Chat

A WhatsApp/Telegram-style chat app that runs entirely on your local network —
no internet, no accounts, no cloud server — plus Xender-style file/app
sharing between any combination of Android and desktop devices on the same
network.

```
lan-chat/
├── protocol/PROTOCOL.md   ← the exact wire format both clients speak
├── desktop/                ← Node.js + Electron client (Windows/Mac/Linux)
└── android/                 ← Kotlin native Android Studio project
```

Read this file top to bottom once — the two things people get stuck on
(discovery not finding a device, and pairing) are both explained here with
the actual reasoning, not just "click this button."

---

## How discovery works (finding devices)

Every device shouts a small "I'm here" packet onto the network every 3
seconds, and every device listens for those packets from everyone else. That
list is your "Nearby devices" sidebar. Nothing is saved to a server anywhere
— if a device stops broadcasting (app closed, phone left the Wi-Fi), it
quietly drops out of the list after ~12 seconds.

That broadcast goes out **three different ways at once**, on purpose:

1. A global broadcast (`255.255.255.255`) — works for most simple home networks.
2. A broadcast targeted at your specific subnet (e.g. `192.168.1.255`) —
   computed from each active network adapter. This is the one that saves you
   if your PC has more than one network adapter (Wi-Fi *and* Ethernet, a VPN
   adapter, a Hyper-V/VMware virtual switch) — Windows can send the global
   broadcast out the wrong adapter entirely, and this layer routes around that.
3. A multicast fallback (`239.255.255.250`) — some routers/firewalls treat
   multicast differently than broadcast, so this catches setups where one is
   blocked and the other isn't.

**If a device still isn't showing up**, in order of likelihood:

- **Windows Firewall.** The very first time you `npm start`, Windows will pop
  up a firewall prompt for Node/Electron asking about Private/Public network
  access. If you clicked "Cancel" or it appeared behind the window and you
  never saw it, the app is silently unable to send or receive anything.
  Fix: Windows Settings → Privacy & Security → Windows Security → Firewall &
  network protection → Allow an app through firewall → find Node.js/Electron
  → check both Private and Public.
- **Different Wi-Fi networks.** Phone on `Home-WiFi`, laptop on
  `Home-WiFi-5G` (a lot of routers broadcast two SSIDs for the two bands) —
  these can sometimes be isolated from each other. Put both devices on the
  exact same network name to rule this out.
- **Router "client/AP isolation."** Some routers (common on guest networks,
  some mesh systems) deliberately block devices from seeing each other even
  on the same SSID. Check your router's settings for "AP isolation" or
  "client isolation" and turn it off for this network.
- **It just takes a few seconds.** The first announce is immediate, but if
  you opened both apps at exactly the same moment, give it 3–6 seconds.

## How pairing works (trusting a device)

Pairing exists so a random device on a coffee-shop Wi-Fi can't just start
messaging you. It only has to happen once per device pair, ever.

**The short version: click the device, agree on one 6-digit PIN with the
other person, done.**

Here's why that's all it takes. Every "I'm here" broadcast (above) already
includes that device's public key — public keys aren't secret, so there's
nothing lost by sending it in the open. That means the only piece of
information two devices *don't* already have about each other is a PIN that
proves you're pairing with the human you think you are, not some other
device that happens to be on the network. So:

1. Click the device's name in "Nearby devices." If you haven't paired yet,
   this opens the pairing dialog for that device and shows a 6-digit PIN.
2. Tell that PIN to the person on the other device — say it out loud, text
   it, whatever's convenient.
3. On the *other* device, click your name in *their* "Nearby devices" list.
   Their dialog also generated its own PIN by default — they replace it with
   the PIN you just gave them, then confirm.
4. Both apps now independently compute the same encryption key from (their
   own private key + your public key + that PIN). Nothing else needs to be
   sent back and forth — if you both used the same PIN, every message from
   now on just works. If you used different PINs by mistake, messages will
   fail to decrypt (a loud, obvious error) rather than silently going
   through garbled — so a typo is easy to catch and just means re-pairing.

Once paired, clicking that device's name again opens (or closes) your chat
with them — no PIN needed again.

**What this pairing is not:** it's a PIN-salted key exchange, not a
full-blown PAKE protocol (like SPAKE2). It stops someone silently
eavesdropping on your Wi-Fi traffic from being able to pair as you without
knowing the PIN. It does not defend against someone who's actively watching
*and* somehow also learns the PIN — a fine tradeoff for a v1 LAN app, called
out here so nobody assumes more security than is actually there.

## Running it

```bash
cd desktop
npm install
npm run test:core   # proves the whole protocol works locally, no UI, ~2 seconds
npm start            # launches the actual app
```

Run `npm start` on two machines on the same network (or `npm start` on
desktop + the Android app on a phone) and they should find each other within
a few seconds.

For Android: open `android/` in Android Studio, let Gradle sync, run on a
device or emulator. (An emulator's virtual network can be unreliable for UDP
broadcast — testing on a real phone is more representative.)

## Troubleshooting checklist

| Symptom | Likely cause | Fix |
|---|---|---|
| No devices ever appear | Firewall blocking the app | Allow Node/Electron through Windows Firewall (see above) |
| Devices appear, then disappear, then reappear | Normal — a peer drops after ~12s of silence and reappears on its next announce | Nothing to fix, this is expected during startup |
| Pairing dialog shows a PIN but pairing fails | Different PINs used on each side | Re-open pairing on both sides, read the PIN back to double check, retype it exactly |
| Chat messages never arrive after pairing | The two derived keys don't match (mismatched PIN at pairing time) | Re-pair the device — pairing again always overwrites the old (bad) key |
| File transfer never starts | Sender/receiver not paired, or receiver never tapped Accept | Confirm the device shows as paired (no "tap to pair" label), check for an accept prompt on the receiving device |

## Architecture

See `protocol/PROTOCOL.md` for the exact wire format — it's the single
source of truth both clients implement independently. In short:

- **Discovery**: UDP, three-layer broadcast, described above.
- **Chat**: one encrypted TCP connection per paired peer.
- **Transfer**: a small encrypted control connection negotiates each
  transfer (offer → accept → complete), then the actual bytes move over 4
  parallel raw TCP connections for real LAN throughput — this is the
  "Xender" part, including sending an installed Android app's own APK.
- **Crypto**: X25519 for the key exchange, ChaCha20-Poly1305 for encrypting
  everything after that — Node's built-in `crypto` on desktop, Google's Tink
  on Android, deliberately wired to produce byte-identical output so neither
  side needs translation logic.

## What's verified vs. what needs Android Studio

**Verified working right now** (`npm run test:core` proves it, no UI
needed): discovery, pairing, encrypted chat, and a multi-megabyte parallel
file transfer with checksum verification, all passing end to end.

**Written, protocol-accurate, not yet compiled in this environment**: the
Android app. Every Kotlin class is a deliberate mirror of its desktop
counterpart — same JSON shapes, same encrypted-frame byte layout, same
transfer chunk-header format. The first real build/run in Android Studio is
the next milestone; that'll surface anything a text-only review can't catch
(Doze-mode socket behavior, a specific OEM's Wi-Fi multicast quirks, etc.).

## Suggested next steps

1. Get the Android app building and running on a real device, and confirm
   it pairs with the desktop client over your own LAN.
2. QR-code pairing instead of typing a 6-digit PIN — the PIN is already
   short enough to work fine as a spoken/typed exchange, but a QR would be
   even faster in person.
3. Message persistence — SQLite on desktop (`better-sqlite3` is already a
   dependency), Room on Android — so chat history survives an app restart.
4. Group chats — `PROTOCOL.md` §6 already reserves a `group_create` message
   type; the transport layer needs a small extension to fan a message out to
   multiple peers.
5. Transfer progress UI — the core reports completion but not in-flight
   per-chunk progress yet.

Happy to build out any of these next.
