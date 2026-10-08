# Cross-platform packaging architecture
_Exported on 10/8/2026 at 14:38:00 EDT from Cursor (3.22.12)_

---

**User**

Plan a cross-platform packaging architecture for Men of the Line using **Electron for desktop/Steam** and **Capacitor for Android/iOS**, all within the existing repository.

- Keep the existing web client as the single source of truth.
- Place platform-specific code under `platforms/electron/` and `platforms/capacitor/`.
- Reuse existing Canvas rendering, controls, Socket.IO networking, and shared game logic.
- Create a build process that packages the shared frontend without duplicating source files.
- Account for server-rendered pages, authentication, asset paths, and WebSocket connections.
- Keep the existing Node.js server and web deployment unaffected.
- Provide independent development, build, and release commands for web, desktop, Android, and iOS.
- Plan GitHub Actions workflows that build only affected platforms.
- Keep platform-specific code minimal and isolated.

First audit the current repository and identify architectural changes required. Prioritize minimal disruption to the existing website. Do not implement anything yet.

---

**Cursor**

I'll audit the repo's web client, auth, assets, and any existing native/desktop packaging so the plan stays minimal-disruption.

Launching parallel audits of the web client, native API, pocketMOTL, and deployment surfaces.

Audits show a same-origin SSR client and a ready `/api/v1` + `auth.token` path. One product choice will lock the packaging model:

Audit is done. One product choice changes the packaging model a lot, so I need your call before I write the plan.

**Current state (short):**
- Web client is same-origin SSR (EJS + cookie Socket.IO). Absolute `/js`, `/shared`, CSP `connect-src 'self'`.
- Native API already exists: `/api/v1` + Socket.IO `auth.token` (used by pocketMOTL’s separate Kotlin UI).
- No Electron/Capacitor in-repo yet. CI is only a branch-sync job.

**Question:** What should live *inside* the Electron/Capacitor shells?

1. **Play-focused shell** — local packaged `public/` + `shared/` for match UI and a thin API-driven lobby/login; wiki, landing, admin, and email signup stay on the website (system browser / Custom Tabs for OAuth). Closest to “package the frontend without duplicating source,” minimal website disruption.

2. **Full-site shell** — WebView loads the live site (`THIS_URL`) for everything. Thin wrapper only; little/no local asset packaging; website stays source of truth but you are not really shipping a packaged frontend.

3. **Hybrid** — remote site for menus/auth/wiki; local packaged assets only for `/play`. More moving parts (session handoff between remote cookies and local shell).

Which do you want? If you do not care, I will plan **(1) play-focused shell** — best fit for your packaging, reuse, and “minimal website disruption” goals, with pocketMOTL treated as a transitional Android client to retire later.

---

**User**

Go with **Option 1: Play-focused shell**, with some adjustments.

I want the desktop, Android, iOS, and web clients to share as much UI and game code as possible, including the lobby, matchmaking, and account menus. Do not create separate implementations unless technically necessary.

Package the game and essential menus locally. Open secondary website features (wiki, admin, registration, password recovery, etc.) in the system browser.

Use the existing token-based API and Socket.IO authentication for packaged clients. Account for EJS, absolute asset paths, CSP, and differences between cookie and token authentication.

Prioritize minimal changes to the existing website and a single shared frontend codebase.

Keep pocketMOTL intact until the Capacitor Android client is functional and tested. Do not retire it automatically.

Also plan for client/server version compatibility, since packaged apps may run older client versions after the website has updated.

Proceed with the implementation plan, but don't implement yet.

---

**Cursor**

I'll lock Option 1 into a concrete plan: shared lobby/account UI in the web client, token auth for shells, and version compatibility—after a quick look at the current games/lobby entry points.

I have enough to lock the architecture: shared client menus on `/api/v1`, local asset export for shells, and a protocol version gate.

Retrying the plan write with cleaner formatting.

Trying a shorter plan payload — the previous call hit a JSON encoding error.

---

**User**

Also audit the previous native Android implementation (pocketMOTL) and plan its retirement in favor of Capacitor.

- Identify all Kotlin, Gradle, Android Studio, and native UI code that will become obsolete.
- Identify any changes made to the main MOTL server, API, authentication, or shared code specifically for pocketMOTL.
- Preserve server-side functionality useful to Capacitor, especially the token-based API and Socket.IO authentication.
- Identify reusable Android-specific functionality such as fullscreen handling, orientation, notifications, and touch controls.
- Identify obsolete dependencies, build scripts, configuration, documentation, and GitHub Actions.
- Plan to remove the native Android implementation only after the Capacitor version achieves feature parity and passes testing.
- Avoid reverting unrelated improvements or removing functionality used by other clients.
- Include a final cleanup phase with an explicit list of files and dependencies to remove.

Do not delete or modify the existing Android implementation during planning.

---

**Cursor**

I'll audit pocketMOTL and MOTL server touchpoints for Capacitor retirement, then fold a gated cleanup phase into the plan—without changing either codebase.

Updating the plan with a pocketMOTL audit, parity gate, and an explicit post-Capacitor cleanup phase.

Updated the plan with a **pocketMOTL audit and gated retirement** (Phase 8). Nothing in either codebase was changed.

**Findings folded in:**
- pocketMOTL is a separate Kotlin/Compose project (not in menoftheline); no GitHub Actions there.
- Its whole UI/net/model/Gradle stack becomes obsolete after Capacitor parity — including Kotlin mirrors of `shared/` and Socket.IO Java client.
- Server `/api/v1` + `auth.token` + CSRF exemption stay; only `pocketmotl://` defaults/allowlist are scheme-specific cleanup later.
- Reusable for Capacitor: landscape, edge-to-edge, Custom Tabs/deep link, token prefs, cleartext debug, touch polish in shared JS (not Kotlin copy).
- No push-notification code to port.
- Explicit delete list + “keep forever” API list in Phase 8; retirement only after a written parity/sign-off checklist.

New todos: `pocketmotl-parity`, `pocketmotl-retire`. Capacitor phases still leave pocketMOTL untouched until that gate.

