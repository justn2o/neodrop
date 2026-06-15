# NeoDrop mobile (Android + iOS)

A React Native app that runs the **exact same P2P engine** as the desktop app —
Hyperswarm discovery, the Noise-encrypted transfer protocol, codes, passphrase,
resume, SHA-256 verification — by embedding a Node.js runtime on the phone and
reusing the desktop core unchanged.

> **Status: foundation, not a finished build.** The architecture and all the
> app code are here and reuse the tested desktop protocol, but a mobile app
> cannot be compiled or tested in the cloud sandbox where this was written.
> Building it needs a real mobile toolchain (and **iOS needs a Mac + Xcode**).
> Expect some iteration on native dependencies — see "Known work" below.

## How it's built

```
┌──────────────────────────────┐     nodejs-mobile channel (JSON)
│  React Native UI (App.js)     │ ───────────────────────────────┐
│  Home / Send / Receive / …    │ ◀───────────────────────────────┤
└──────────────────────────────┘                                  │
┌──────────────────────────────────────────────────────────────┐ │
│  Embedded Node.js (nodejs-mobile)                              │◀┘
│  nodejs-assets/nodejs-project/main.js   ← mirrors desktop ipc  │
│  └─ core/ {code,swarm,transfer,lan}.js  ← copied from src/main │
│     hyperswarm · @hyperswarm/secret-stream · multicast-dns     │
└──────────────────────────────────────────────────────────────┘
```

- The **UI** (`App.js`) holds no networking logic. It sends commands
  (`send`, `receive`, `accept`, `reject`, `cancel`) and renders the events the
  backend emits (`progress`, `offer`, `done`, `error`, …).
- The **backend** (`nodejs-assets/nodejs-project/main.js`) is the desktop
  `ipc.js` adapted to the nodejs-mobile channel. It imports the **same**
  `code.js` / `swarm.js` / `transfer.js` / `lan.js`.
- `core/` is a copy of `../src/main` (single source of truth on desktop). Run
  `npm run sync-core` after changing the core.

Choosing files on a phone replaces drag-and-drop: `react-native-document-picker`
copies the picked files into the app cache, and the backend reads those paths.
Received files are written to `Download/NeoDrop` (Android) or the app documents
dir (iOS), then the user can open/share them.

## Prerequisites

- Node.js ≥ 20, the React Native CLI environment
  (https://reactnative.dev/docs/environment-setup).
- **Android:** Android Studio + SDK/NDK.
- **iOS:** a **Mac** with Xcode and CocoaPods, plus an Apple Developer account
  to run on a real device.

## Setup

```bash
cd mobile
npm install
npm run sync-core          # copy the protocol core from ../src/main
cd nodejs-assets/nodejs-project && npm install && cd ../..

# Android
npm run android

# iOS (on a Mac)
cd ios && pod install && cd ..
npm run ios
```

## Known work before it ships

The protocol logic is reused as-is, but a phone build still needs:

1. **Native modules for the mobile ABI.** Hyperswarm pulls in `sodium-native`
   and `udx-native` (native code). They must be built for Android (arm64/x86_64)
   and iOS via `nodejs-mobile`'s native-module flow (`nodejs-mobile-gyp`). If
   prebuilds aren't available they need cross-compiling. This is the main risk.
   (Holepunch's own **`bare` runtime** + `react-native-bare-kit` is the
   alternative path they use in Keet; it avoids nodejs-mobile but requires
   porting the `crypto`/`zlib` calls. Either path is viable.)
2. **Permissions / storage** wiring: Android scoped storage for writing to
   `Download/`, iOS document export, and a foreground service so a transfer
   keeps running if the app backgrounds.
3. **Icons / splash** and store metadata.

Everything above the native layer (UI, bridge, protocol) is done and mirrors the
desktop app one-to-one.
