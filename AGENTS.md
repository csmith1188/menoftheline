# AGENTS.md — Men of the Line

Index for agents. Read this first, then open only the files listed for your task.

## What this is

Real-time 1v1 lane-pusher (keeps, top/bottom lanes, gold/land economy, orders, shooting/melee).  
Node ESM + Express + Socket.IO + SQLite. Match sim is authoritative on the server; clients render snapshots and emit commands.

## Run

| Command | Purpose |
|---------|---------|
| `npm start` | Production-ish server (`app.js`) |
| `npm run dev` | Nodemon on `app.js` |
| `npm run debug` | Same server with `DEBUG_RANGES=1` overlays |
| `npm test` | Node built-in test runner (`test/*.test.js`) |
| `npm run sim-bench` | One crowded match: step and snapshot times |
| `npm run mail-test` | SMTP diagnose + optional test send (`--to`, `--verify-only`, `--force`) |
| `npm run seed-wiki` | Load `wikidocs/*.md` into the wiki DB (`--dry-run`, `--only-missing`) |
| `npm run load -- bot` | Socket.IO load (`bot`, `pvp`, or `mixed`). Set `LOAD_DURATION_MS`. |
| `npm run export-graphics` | Transparent PNGs of lanes/keeps/towns/terrain/units → `public/img/` |

Env template: `.env.template`. Local data/DB under `data/`. Auth: local email/password (`LOCAL_ACCOUNTS`, `AUTH_EMAIL`, SMTP_*), Formbar OAuth (`FORMBAR_LOGIN`), and/or Discord OAuth (`DISCORD_LOGIN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`); Digipog tickets still use Formbar (`server/formbar.js`). In-match chat: `MATCH_CHAT` (default on). Logging: Pino via `server/logger.js` (`LOG_LEVEL`, default `info`); see `docs/logging.md`.

## Layout (start here)

```
app.js              HTTP + sessions + local/Formbar/Discord auth + Socket.IO + wiki/admin routes
server/
  room.js              GameRoom: seats, command queue → sim, emit "state" / "chat"
  ticker.js            One 50ms loop for every playing room; snapshots at STATE_MS
  metrics.js           METRICS=1 counters (tick, snapshot, event loop, sqlite)
  commandLimit.js      Per-socket command token bucket and socket event limits
  csrf.js              Session CSRF tokens for browser POST forms
  hardening.js         Session secret, cookie, origin, and security headers
  formbarAuth.js       Formbar RS256 JWT verification via AUTH_URL/certs
  logger.js            Central Pino logger (child bindings for matchId/userId/socketId)
  chat.js              Match chat sanitize, rate limit, MATCH_CHAT flag re-export
  settingsWrite.js     Debounced tooltip / BGM preference writes (accounts only)
  prefsCookie.js       Guest tooltips/BGM cookies; logged-in DB values overwrite cookies
  sim.js               GameSim + Unit classes + combat/economy rules (large)
  matchmaking.js       Queues, ranked/listed/bot/training rooms, userId indexes
  owners.js            Optional WORKER_COUNT owner assignment (not sim sync)
  bot.js               Re-exports BotController
  bot/                 AI: controller, assess, tactics, formations, economy, commands
  training.js          Training-mode rule tweaks
  trainingBot.js       Scripted training opponent
  admin/               Staff dashboard (role authz, audit, users, analytics, logs, matches, ops, routes)
  db.js                SQLite accounts (internal id), tickets, wiki, suggestions, games, admin audit/ledger
  auth.js              Local auth flags (incl. MATCH_CHAT), scrypt passwords, tokens, rate limits, EN/ES name filter (glin-profanity)
  mail.js              Nodemailer verify/reset email (SMTP_*)
  rating.js            MMR/Elo
  news.js              Landing news from data/news.json
  wiki-render.js       Markdown → HTML for wiki
  wiki-diff.js         Revision diffs
  formbar.js           Digipog transfers; one outstanding socket transfer at a time
  discord.js           Discord OAuth authorize/token/user helpers
  load-env.js          dotenv load (imported first by app.js)
shared/                Authoritative tunables + geometry used by server, client, tests
  config.js            CONFIG numbers (board, economy, combat, UI colors, …)
  units.js             UNIT_STATS, variants, labels, BUY_UNITS, mobilityClass, cost helpers
  path.js              Path / lanes / progress / fort cover helpers (board via Path.useBoard)
  map/                 GameMap classes: definition, registry, classic/empty coded maps, income
  maps.js              Compatibility shim (MAP_PRESETS, resolveMapFeatures → map/)
  matchOptions.js      Custom lobby knobs (speed, fog, map, forts, base GPS)
  terrain.js           Terrain rules: move, LOS/fog, cover, range, snapshot helpers
  unitInfo.js          Player-facing unit copy + derived info panels
public/js/             Browser match client (ES modules, imports ../shared/)
  main.js              2D match bootstrap: socket, lobby, menus
  main3d.js / scene3d.js   3D match client
  board.js             Hit-testing, HUD geometry, buy UI helpers
  render.js            Canvas draw + applySnapshot
  mapView.js           Install Path board from snapshot.map; lane kind helpers
  mapPreview.js        Lobby create map preview canvas
  input.js             Pointer → command payloads
  rules.js             In-match how-to diagrams (reads live CONFIG/UNIT_STATS)
  unitInfo.js          In-match unit info overlay (uses shared/unitInfo.js)
  chat.js              In-match chat bubble + panel (Socket.IO `chat`)
  tooltips.js, tutorial.js, audio.js, buyArt.js, suggestion.js, debugRanges.js
public/css/            game.css, landing.css, admin.css
views/                 EJS shells (landing, play, wiki, admin/, scores, lobby-create, …)
wikidocs/              Canonical player-facing rules markdown (wiki source content)
test/                  Sim/bot/UI metric tests; helpers in test/helpers.js
scripts/debug-server.js  Sets DEBUG_RANGES then imports app.js
scripts/load/          socket-load.js (100-player harness), sim-bench.js
deploy/nginx.conf.example  One Node process behind Nginx; static files cached
goals.md               Backlog / roadmap (not docs)
data/                  Runtime DB, news.json (do not commit secrets)
```

## Task router

| If you need to… | Open first | Then usually |
|-----------------|------------|--------------|
| Add / change server logging | `server/logger.js`, `docs/logging.md` | Child loggers in `room.js` / `matchmaking.js` / `app.js`; never log secrets |
| Change a number (range, cost, income, board size) | `shared/config.js` | Confirm consumers; update `wikidocs/` + `public/js/rules.js` if player-visible |
| Add/change unit stats or variants | `shared/units.js` | `server/sim.js` (class/`UNIT_KINDS`), `shared/unitInfo.js`, buy UI (`board.js`/`render.js`/`scene3d.js`), `wikidocs/units.md`, tests |
| Movement / lanes / progress / forts / LoS geometry | `shared/path.js` | `shared/map/` (lane catalog), `shared/terrain.js`, `public/js/board.js` (HUD Cover), `wikidocs/map.md` |
| Add / change a map (lanes, towns, terrain, rules) | `shared/map/maps/` + `GameMap` | `shared/map/registry.js`, Path board context, `server/sim.js`, clients via `snapshot.map`, `test/map.test.js`, `wikidocs/map.md` |
| Terrain / fog / map presets | `shared/terrain.js`, `shared/map/` (`maps.js` shim) | `shared/config.js` tunables, `server/sim.js` + per-seat `server/room.js` snapshots, `public/js/render.js` / `scene3d.js`, `wikidocs/map.md`, `test/terrain.test.js` |
| Combat, orders, fatigue, pushback, keeps, towns | `server/sim.js` (`GameSim`, `Unit`, `applyCommand`) | `test/*.test.js`, matching `wikidocs/*.md` |
| Player commands (buy, order, bank, upgrade, …) | `GameSim.applyCommand` in `server/sim.js` | `server/room.js` (queue), `public/js/input.js` (emit), bot `server/bot/commands.js` / `economy.js` |
| Match lifecycle / tick / sockets | `server/room.js` | `server/matchmaking.js`, `public/js/main.js` (listen `state`/`lobby`) |
| In-match chat (`MATCH_CHAT`) | `server/chat.js`, `server/room.js` (`roomChatActive`) | Only human vs human with both seats logged in (no bots/guests); per-seat chat rate limit; `public/js/chat.js`, play EJS, `game.css`; longer `adminChatLog` persisted as `games.chat_json` for `/admin/games/:id` |
| Report opponent (non-bots) | `server/room.js` (`report`), `server/db.js` (`player_reports`) | Settings → Report player; socket `report` / `reportResult`; one report forever per reporter→reported account pair; guests/bots not reportable; admin `/admin/reports` + user detail |
| Reconnect spam / disconnect forfeit | `server/room.js` (`noteReconnectSpam`, reconnect wait) | Mid-match reconnect spam force-concedes; tunables `reconnectSpamMax` / `reconnectSpamWindowMs` in `shared/config.js` |
| Match pause / unpause | `server/room.js` (`pause`, `settingsOpen`, `simFrozen`) | Human mutual pause + `UNPAUSE_MS` countdown; bot menu freeze via `settingsOpen`; clients `main.js` / `main3d.js`, settings Pause button, chat pause-alert CSS |
| Bot behavior | `server/bot/controller.js` | `assess.js`, `tactics.js`, `formations.js`, `economy.js`, `commands.js` |
| Matchmaking / ranked / tickets | `server/matchmaking.js` | `server/db.js`, `server/rating.js`, `app.js` routes |
| Local signup / verify / reset / Formbar / Discord login flags | `server/auth.js`, `server/mail.js`, `server/discord.js` | `server/db.js` accounts (`formbar_id` / `discord_id`), `app.js` routes, `views/login.ejs` / signup / forgot / reset / profile. Profile link merges when the identity is already taken (union providers; refuse same-provider conflicts). New accounts take the provider/local display name; collisions get `Name 2`…; owners can rename on profile (1 ticket, 3/hour). |
| Tooltips / BGM prefs (guest cookies vs account DB) | `server/prefsCookie.js`, `shared/prefs.js`, `public/js/prefs.js` | Guests: cookies only. Logged-in: `accounts` via `settingsWrite` / `setPlayer*`; login and `/play` overwrite cookies from DB. |
| Formbar token check, CSRF, request limits | `server/formbarAuth.js`, `server/csrf.js`, `server/hardening.js` | `server/formbar.js`, `app.js` (static assets before session), `test/security.test.js` / `test/securityHttp.test.js` |
| Custom listed lobby settings | `shared/matchOptions.js`, `views/lobby-create.ejs` | `GameRoom` / `GameSim.applyMatchOptions`, `listLobbies`, `public/js/mapPreview.js` |
| Native/mobile client API | `app.js` (`/api/v1/*`, socket `auth.token`) | `test/clientApi.test.js`, Android app in pocketMOTL |
| Site pages / auth / wiki admin | `app.js` + `views/*.ejs` | `server/db.js`, `wikidocs/` |
| Admin dashboard (roles, users, analytics, logs, games, ops, reports) | `server/admin/` (`routes.js`, `auth.js`, …) | `views/admin/` (incl. `reports.ejs`), `server/db.js` (audit/ledger/activity/`player_reports`), `public/css/admin.css` |
| Buy Digipog tickets (site) | `GET /buy` → `views/tickets.ejs` | Header ticket link; form partial `views/buy.ejs` posts `POST /tickets` |
| Suggestion / bug / wiki submit limits | `server/db.js` (`sanitizeUserText`, count/spend helpers) | `app.js` routes, `views/suggestion-modal.ejs`, `views/wiki-edit.ejs` |
| 2D visuals / HUD | `public/js/render.js`, `board.js` | `public/css/game.css` |
| 3D visuals | `public/js/scene3d.js`, `main3d.js` | `views/play3d.ejs` |
| In-match rules diagrams | `public/js/rules.js` | Must stay consistent with `shared/` + `wikidocs/` |
| Player docs | `wikidocs/` (index: `rules.md`) | Live wiki is DB-backed via `server/db.js`; `npm run seed-wiki` upserts markdown into the DB; keep files in sync when rules change |
| Product ideas / unfinished work | `goals.md` | — |

### Command / socket cheat sheet

- Client → server: `command` (payload to `sim.applyCommand`), also `chat` (`{ text }`), `report` (`{ text }`), `pause`, `pauseSeen`, `settingsOpen`, `leave`, `concede`, `tooltips`, `bgmVolume`, `botSettings`, `debugPlay`.
- Server → client: `state` (public snapshot; includes pause fields), `lobby` (includes `chatEnabled` / `chatHistory` when chat on, `canReport` / `alreadyReported`, plus pause fields), `chat` (user/system lines), `reportResult`, `go-home`, `replaced`.
- Pause: human vs human mutual pause via settings `pause` (chat request + red chat alert until `pauseSeen` or both pause); both pause freezes sim; unpause votes or `UNPAUSE_MS` (60s) countdown resumes. Bot/training-vs-bot: `settingsOpen` freezes while the settings menu is open. Mid-match disconnect: `DISCONNECT_GRACE_MS` (5s) then `RECONNECT_WAIT_MS` (60s) frozen wait (“Waiting for opponent to reconnect”); timeout auto-concedes the disconnected seat.
- Pre-game lobby overlay (`#lobby`): logo; once an opponent is seated (waiting or countdown) show them and two-click Concede; alone waiting uses Leave (abandon). Leave/concede with both seats filled forfeits (tickets stay charged if already charged).
- Command `type`s handled in sim: `buy`, `bank`, `targeting`, `townProduce` / `upgrade`, `order`. Chat is not a sim command.
- Native/client JSON API: `POST /api/v1/session`, `GET /api/v1/me`, Formbar `GET /api/v1/login` + callback / `POST /api/v1/login/token`, Discord `GET /api/v1/login/discord` + callback, `POST /api/v1/logout`, `GET /api/v1/lobbies`, `GET /api/v1/match-options`, `POST /api/v1/tickets`, `POST /api/v1/play` (guest + ranked/listed/join). Socket handshake may send `auth.token` (express-session id) instead of the `lane.sid` cookie.

### Shared code rule

Tunables and unit definitions live in `shared/`. Server and `public/js/` both import them. Prefer changing shared values over duplicating constants in client or bot code.

## Conventions

- ESM (`"type": "module"`); Node tests via `node --test`.
- Prefer editing existing modules over new folders.
- `server/sim.js` is large — search by class/method (`Unit`, `GameSim`, `applyCommand`, unit subclasses) before reading top-to-bottom.
- Tests spawn through `test/helpers.js` (`makeSim`, `spawn`, `stepBot`) so buy/path behavior stays real.
- Do not commit `.env` or `data/*.sqlite`.

## After you add a feature or change behavior

Work top-to-bottom; skip rows that do not apply.

1. **Shared source of truth** — Update `shared/config.js` and/or `shared/units.js` (and `shared/path.js` / `shared/unitInfo.js` if geometry or player copy changed).
2. **Sim / authority** — Update `server/sim.js` (and `server/room.js` / `server/matchmaking.js` only if lifecycle or networking changed).
3. **Bot** — Teach or retune AI in `server/bot/*` if the change affects buy/order/economy decisions.
4. **Client** — Update `public/js/input.js` for new commands; `board.js` / `render.js` (and `scene3d.js` if 3D) for UI/state display; `main.js` / `main3d.js` only for wiring.
5. **In-match guide** — Refresh diagrams/text in `public/js/rules.js` when player-visible rules or numbers change.
6. **Wiki markdown** — Update the matching file(s) under `wikidocs/` (start from `wikidocs/rules.md` links). Especially: `units.md`, `economy.md`, `orders.md`, `shooting.md`, `melee.md`, `damage.md`, `fatigue.md`, `map.md`, `lines.md`, `towns.md`.
7. **Site chrome** — Touch `views/*.ejs` / `public/css/*` only if landing, lobby, wiki UI, or admin surfaces need the change.
8. **Tests** — Add or extend coverage under `test/` (use `test/helpers.js`). Register new files in the `test` script in `package.json`.
9. **Verify** — Run `npm test`. Manually smoke the affected mode (`npm run dev` or `npm run debug`) if UI or networking changed.
10. **Backlog** — Clear or adjust the relevant item in `goals.md` if the work came from there.
11. **This index** — If you added a module, command type, or major folder responsibility, update the Layout / Task router sections above.
