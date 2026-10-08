# Packaging (Electron + Capacitor)

Play-focused shells package a static export of the web frontend and talk to the live Node server via `/api/v1` + Socket.IO `auth.token`. Secondary site features (wiki, admin, signup, password reset) open in the system browser.

## Commands (repo root)

| Command | Purpose |
|---------|---------|
| `npm start` / `npm run dev` | Website + game server (unchanged) |
| `npm run client:export` | Build `dist/client/` from `public/` + `shared/` + three.js |
| `npm run desktop:dev` | Export + run Electron against `MOTL_SERVER_URL` (default `http://127.0.0.1:3000`) |
| `npm run desktop:build` | Export + electron-builder |
| `npm run android:dev` | Export + Capacitor sync + open Android Studio |
| `npm run android:build` | Export + Capacitor sync |
| `npm run ios:dev` / `ios:build` | Same for iOS (macOS) |

Set `MOTL_SERVER_URL` when exporting or launching shells so packaged clients know the game host. Website browsers ignore it (same-origin).

## Layout

```
dist/client/              # gitignored export
platforms/electron/       # desktop shell
platforms/capacitor/      # mobile shell (android/ ios)
public/js/runtime.js      # cookie vs token, server URL, socket, external links
public/js/menus/          # shared games / lobby / account UI
public/app/*.html         # static entrypoints for shells
shared/protocol.js        # PROTOCOL_VERSION + CLIENT_VERSION
```

## Auth

- **Website:** cookie `lane.sid` (unchanged). Shared menus may call `/api/v1` with credentials cookies (Bearer optional).
- **Shells:** `POST /api/v1/session` → store token → `Authorization: Bearer` + Socket.IO `auth.token`.
- **OAuth:** system browser / Custom Tabs → `/api/v1/login?return=motl://auth` → deep link `motl://auth?token=…`.
- Server allowlists only `motl://auth` for native OAuth return.

## Version compatibility

- `GET /api/v1/version` → `{ protocol, minProtocol, serverVersion, assetVersion }`
- Packaged clients send `x-motl-protocol` / Socket.IO `auth.protocol`.
- If client protocol < `minProtocol` (env `MOTL_MIN_PROTOCOL`, default = current `PROTOCOL_VERSION`): HTTP 426 / socket error `client_outdated`.
- Missing protocol is allowed (legacy website sockets and older native clients).
- Bump `PROTOCOL_VERSION` in `shared/protocol.js` only for breaking wire changes.

## CI

Path-filtered workflows:

- `.github/workflows/web.yml` — `npm test`
- `.github/workflows/desktop.yml` — export + electron-builder
- `.github/workflows/android.yml` — Capacitor Android
- `.github/workflows/ios.yml` — Capacitor iOS

## Steam

Use Electron release channel / electron-builder artifacts; Steamworks integration is a follow-on, not a separate UI stack.

## pocketMOTL (retired)

The separate Kotlin/Compose Android app (`Desktop/pocketMOTL`) is **retired** as a supported client. The folder may remain on disk as an archive; it is not built, documented as current, or allowlisted by the server.

**Kept forever (used by Capacitor / Electron / web / tests):**

- Full `/api/v1/*`, cookie-or-Bearer session auth, Socket.IO `auth.token`, CSRF exemption for `/api/v1`

**Removed at retirement:**

- Server deep-link allowlist entry `pocketmotl://auth` (only `motl://auth` now)
- Capacitor dual `pocketmotl` intent-filter; Electron `pocketmotl://` handling

**Do not delete** the pocketMOTL working tree unless you choose to archive it yourself later.
