# NeoDrop

Desktop app for **peer-to-peer** file transfer between distant computers, with
**no server to host**. Peers find each other through the public
[Hyperswarm](https://github.com/holepunchto/hyperswarm) DHT (and, on the same
network, via mDNS) and open a direct, end-to-end encrypted connection (Noise
protocol, UDP hole punching).

At a glance: files **and folders**, on-the-fly **compression** of compressible
files, **resume after a drop**, **local-network discovery**, a **QR code** for
the pairing code, optional **stronger codes** and **passphrase**, system
**notifications**, a **tray icon**, **history**, image **thumbnails**, a
**speed limit**, and a **command-line mode**.

Thanks to Claude Code for the debugging, advice, those really tough matches, and code comments 🫰

## How it works

1. **Send**: drop one or more files — **or a whole folder** — onto the app (or
   use the "Files…" / "Folder…" buttons). A short pairing code is generated
   (e.g. `TIGER-7342`) and also shown as a **QR code** to scan from a phone.
2. **Receive**: on the other computer, anywhere in the world, enter the code.
   If it is on your clipboard it is filled in automatically.
3. The recipient **explicitly confirms** the transfer and **picks the
   destination folder** ("Change…" button, remembered) — nothing is written to
   disk before they agree. A folder's tree is recreated exactly, and images get
   a **preview**.
4. Transfer with progress on both sides (speed, time left), then a **SHA-256
   integrity check**. A dropped connection can be **resumed** instead of
   resending everything.
5. The code is **single-use** and expires after **15 minutes** without a
   connection.

## Send options

Under the "Options" panel on the send screen:

- **Code strength**: 1 word (~22 bits), 2 words (~31 bits), or 3 words
  (~41 bits) for sensitive transfers.
- **Passphrase**: a secret phrase required in addition to the code. It is folded
  into the key derivation (both the topic and the auth key), so without it no
  one can pair even if they know the code.
- **Speed limit** (MB/s) to avoid saturating your connection.
- **Compression** of compressible files (text, code, etc.), transparent.

## Resume after a drop

If the connection drops mid-transfer, the partial file is kept in a local cache.
Restarting the receive with the **same code** resumes where it left off instead
of resending everything. The final SHA-256 always covers the whole file, so a
bad prefix is detected and the file is re-requested if needed.

## Local-network discovery

When both peers are on the same network, NeoDrop finds them in milliseconds via
**mDNS**, alongside the DHT. The local socket is wrapped in the **same Noise
encryption** as Hyperswarm, so end-to-end confidentiality is preserved (the UI
shows "local network"). It fails silently: if multicast is blocked, the DHT
takes over.

## On-the-fly compression

Compressible formats (`.txt`, `.json`, `.csv`, `.svg`, source code…) above 4 KB
are compressed with **brotli** during transport, then decompressed on arrival.
Already-compressed formats (zip, jpg, mp4…) are sent as-is. Compression is
transport-only: the **SHA-256 covers the original bytes**, so integrity is not
weakened.

## History, notifications, tray

- **History** of recent transfers (from the home screen), stored locally,
  clearable.
- **Notifications** when a peer connects and when a transfer ends, useful when
  the window is in the background.
- **Tray icon**: keep a pending code in the background and return with one click.

## Command line

NeoDrop also runs without a UI (same guarantees: encrypted, verified):

```bash
# Send (prints a code) — files and/or folders
node bin/cli.js send file.zip folder/ --strength high --pass "my phrase"

# Receive
node bin/cli.js receive TIGER-7342 --out ./received --yes

# Or just the interactive menu
node bin/cli.js
```

Options: `--strength high|max`, `--pass PHRASE`, `--no-compress`,
`--limit MB/s`, `--out DIR`, `--yes`. Installed globally, the command is just
`neodrop`.

## Security

- Code generated with Node's CSPRNG (`crypto.randomBytes`), ~22 bits of entropy
  (1 word), up to ~41 bits in stronger mode (3 words).
- DHT topic derived from the code with **scrypt** (slow) then HKDF: no trivial
  brute force of topics observed on the DHT.
- **Optional passphrase** folded into the derivation: protects even if the code
  is guessed or intercepted.
- The code **never travels in clear**: a mutual HMAC-SHA256 challenge-response
  over random nonces, with reflection protection, bound to the Noise channel
  (handshakeHash) to defeat relay/MITM.
- On the sender side, **3 failed attempts invalidate the code**.
- Sockets are end-to-end encrypted by Hyperswarm (Noise) — including on the
  **local network** (same Noise protocol).
- Hardened Electron renderer: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. All network/file logic lives in the main process.
- Received file names are sanitized (no `../`, no Windows-forbidden characters
  or reserved names); collisions handled (`file (1).ext`). For a folder, each
  component of the relative path is sanitized: nothing can be written outside
  the destination folder.

## Requirements

- [Node.js](https://nodejs.org) >= 20 and npm
- Internet (UDP) for the Hyperswarm DHT (local mDNS discovery also works offline,
  between peers on the same network)

## Development

```bash
npm install
npm start
```

To test a full local transfer, run **two instances**:

```bash
npm start   # terminal 1 -> Send
npm start   # terminal 2 -> Receive
```

## Tests

```bash
npm test
```

Covers (31 tests): code generation/validation (including stronger codes and
passphrase), secret derivation, framing, file-name sanitization,
challenge-response (right/wrong code, channel binding, invalidation after 3
failures), deterministic connection selection, multi-file and folder transfers
with hash verification, compression, pipelined sending, resume after a drop,
rejection of a corrupted file, cancellation and `.part` cleanup, bounded
streaming memory, and a full round-trip over a local DHT.

## Build (Windows, macOS, Linux)

```bash
npm run build:win     # NSIS installer (.exe)
npm run build:mac     # .dmg (x64 + arm64)
npm run build:linux   # AppImage (x64)
```

Artifacts land in `dist/`. The shared icon is `build/icon.png`. A GitHub Actions
workflow (`.github/workflows/build.yml`) builds all three on native runners and,
on a `v*` tag, publishes a Release with the three artifacts attached.

> **Cross-building from Linux/macOS**: the NSIS target then needs wine (with
> 32-bit support). On **Windows**, just run `npm run build:win`.

## Project layout

```
├── package.json
├── electron-builder.yml
├── bin/
│   └── cli.js           # command-line mode (no Electron)
├── build/
│   └── icon.png         # app / installer icon
├── src/
│   ├── main/
│   │   ├── index.js      # Electron lifecycle, window, tray
│   │   ├── code.js       # codes (1-3 words), passphrase, topic derivation
│   │   ├── swarm.js      # Hyperswarm + mDNS: join, connections, auth
│   │   ├── lan.js        # local-network discovery (mDNS), Noise-encrypted
│   │   ├── transfer.js   # protocol: chunks, hash, compression, resume
│   │   └── ipc.js        # IPC handlers, notifications, history, QR, thumbnails
│   ├── preload/
│   │   └── index.js      # minimal API exposed to the renderer
│   ├── assets/           # bundled icons (app + tray)
│   └── renderer/
│       ├── index.html
│       ├── styles.css
│       └── app.js
└── test/                 # automated tests (npm test)
```

## Known limits

- Both apps must be **open at the same time** during the transfer (no mailbox:
  it is direct). **Resume** only works if you restart with the same code while
  both peers are online again.
- Very restrictive networks (double NAT/CGNAT, corporate firewalls) may **block
  hole punching**; the transfer then goes through a (still encrypted) relay or
  fails with a timeout.
- On **first launch on Windows**, allow the app through the Windows Firewall when
  prompted (needed for incoming connections and local discovery).
- `This app was developed with the help of Claude Code. As a result, it may contain bugs, inconsistencies, and missing features. I am not a professional developer, and I admit that I am not one.`
