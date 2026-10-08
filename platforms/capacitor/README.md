# Capacitor (Android / iOS)

Play-focused shell around `dist/client`. This is the supported Android/iOS client (the separate pocketMOTL Kotlin app is retired).

## Setup

From repo root:

```bash
npm run client:export
cd platforms/capacitor
npm install
npx cap add ios       # once, macOS — android/ is already in-tree
```

Set the game server URL before packaging by exporting with:

```bash
MOTL_SERVER_URL=https://your-game-host npm run client:export
```

Or inject `window.MOTL_SERVER_URL` in native code.

## Deep links

Register `motl://auth` (Android intent-filter is already on the main activity; iOS URL types when you add the iOS project).

## Android behaviors

- Orientation: `sensorLandscape` on the main activity
- Cleartext HTTP for debug builds only (local MOTL server)
- Status bar / edge-to-edge via `@capacitor/status-bar` as needed
- Custom Tabs / system browser via `@capacitor/browser` (used by `public/js/runtime.js`)

See `android-config-notes.md` for details.

## Commands (from repo root)

- `npm run android:dev` — export, sync, open Android Studio
- `npm run android:build` — export + Capacitor sync
- `npm run ios:dev` / `ios:build` — same for iOS on macOS
