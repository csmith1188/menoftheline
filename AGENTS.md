# AGENTS.md — Men of the Line

Index for agents. Read this first, then open only the files listed for your task.

## What this is

Real-time 1v1 lane-pusher (keeps, top/bottom lanes, gold/land economy, orders, shooting/melee).  
Node ESM + Express + Socket.IO + SQLite. Match sim is authoritative on the server; clients render snapshots and emit commands.

## Run

| Command | Purpose |
|---------|---------|
| `npm start` | Production-ish server (`server.js`) |
| `npm run dev` | Nodemon on `server.js` |
| `npm run debug` | Same server with `DEBUG_RANGES=1` overlays |
| `npm test` | Node built-in test runner (`test/*.test.js`) |
| `npm run sim-bench` | One crowded match: step and snapshot times |
| `npm run load -- bot` | Socket.IO load (`bot`, `pvp`, or `mixed`). Set `LOAD_DURATION_MS`. |

Env template: `.env.template`. Local data/DB under `data/`. Auth: local email/password (`LOCAL_ACCOUNTS`, `AUTH_EMAIL`, SMTP_*) and/or Formbar OAuth (`FORMBAR_LOGIN`); Digipog tickets still use Formbar (`server/formbar.js`).

## Layout (start here)

```
server.js              HTTP + sessions + local/Formbar auth + Socket.IO + wiki/admin routes
server/
  room.js              GameRoom: seats, command queue → sim, emit "state"
  ticker.js            One 50ms loop for every playing room; snapshots at STATE_MS
  metrics.js           METRICS=1 counters (tick, snapshot, event loop, sqlite)
  commandLimit.js      Per-socket command token bucket
  settingsWrite.js     Debounced tooltip / BGM preference writes
  sim.js               GameSim + Unit classes + combat/economy rules (large)
  matchmaking.js       Queues, ranked/listed/bot/training rooms, userId indexes
  owners.js            Optional WORKER_COUNT owner assignment (not sim sync)
  bot.js               Re-exports BotController
  bot/                 AI: controller, assess, tactics, formations, economy, commands
  training.js          Training-mode rule tweaks
  trainingBot.js       Scripted training opponent
  db.js                SQLite accounts (internal id), tickets, wiki, suggestions, games
  auth.js              Local auth flags, scrypt passwords, tokens, rate limits, EN/ES name filter (glin-profanity)
  mail.js              Nodemailer verify/reset email (SMTP_*)
  rating.js            MMR/Elo
  news.js              Landing news from data/news.json
  wiki-render.js       Markdown → HTML for wiki
  wiki-diff.js         Revision diffs
  formbar.js           External auth/pay socket
  load-env.js          dotenv load (imported first by server.js)
shared/                Authoritative tunables + geometry used by server, client, tests
  config.js            CONFIG numbers (board, economy, combat, UI colors, …)
  units.js             UNIT_STATS, variants, labels, BUY_UNITS, mobilityClass, cost helpers
  path.js              Path / lanes / progress / fort cover helpers
  maps.js              Named map presets (terrain feature layouts)
  matchOptions.js      Custom lobby knobs (speed, fog, map, forts, base GPS)
  terrain.js           Terrain rules: move, LOS/fog, cover, range, snapshot helpers
  unitInfo.js          Player-facing unit copy + derived info panels
public/js/             Browser match client (ES modules, imports ../shared/)
  main.js              2D match bootstrap: socket, lobby, menus
  main3d.js / scene3d.js   3D match client
  board.js             Hit-testing, HUD geometry, buy UI helpers
  render.js            Canvas draw + applySnapshot
  mapPreview.js        Lobby create map preview canvas
  input.js             Pointer → command payloads
  rules.js             In-match how-to diagrams (reads live CONFIG/UNIT_STATS)
  unitInfo.js          In-match unit info overlay (uses shared/unitInfo.js)
  tooltips.js, tutorial.js, audio.js, buyArt.js, suggestion.js, debugRanges.js
public/css/            game.css, landing.css
views/                 EJS shells (landing, play, wiki, admin, scores, lobby-create, …)
wikidocs/              Canonical player-facing rules markdown (wiki source content)
test/                  Sim/bot/UI metric tests; helpers in test/helpers.js
scripts/debug-server.js  Sets DEBUG_RANGES then imports server.js
scripts/load/          socket-load.js (100-player harness), sim-bench.js
deploy/nginx.conf.example  One Node process behind Nginx; static files cached
goals.md               Backlog / roadmap (not docs)
data/                  Runtime DB, news.json (do not commit secrets)
```

## Task router

| If you need to… | Open first | Then usually |
|-----------------|------------|--------------|
| Change a number (range, cost, income, board size) | `shared/config.js` | Confirm consumers; update `wikidocs/` + `public/js/rules.js` if player-visible |
| Add/change unit stats or variants | `shared/units.js` | `server/sim.js` (class/`UNIT_KINDS`), `shared/unitInfo.js`, buy UI (`board.js`/`render.js`/`scene3d.js`), `wikidocs/units.md`, tests |
| Movement / lanes / progress / forts / LoS geometry | `shared/path.js` | `shared/terrain.js` (cover and fort slow), `public/js/board.js` (HUD Cover), `wikidocs/map.md` |
| Terrain / fog / map presets | `shared/terrain.js`, `shared/maps.js` | `shared/config.js` tunables, `server/sim.js` + per-seat `server/room.js` snapshots, `public/js/render.js` / `scene3d.js`, `wikidocs/map.md`, `test/terrain.test.js` |
| Combat, orders, fatigue, pushback, keeps, towns | `server/sim.js` (`GameSim`, `Unit`, `applyCommand`) | `test/*.test.js`, matching `wikidocs/*.md` |
| Player commands (buy, order, bank, upgrade, …) | `GameSim.applyCommand` in `server/sim.js` | `server/room.js` (queue), `public/js/input.js` (emit), bot `server/bot/commands.js` / `economy.js` |
| Match lifecycle / tick / sockets | `server/room.js` | `server/matchmaking.js`, `public/js/main.js` (listen `state`/`lobby`) |
| Bot behavior | `server/bot/controller.js` | `assess.js`, `tactics.js`, `formations.js`, `economy.js`, `commands.js` |
| Matchmaking / ranked / tickets | `server/matchmaking.js` | `server/db.js`, `server/rating.js`, `server.js` routes |
| Local signup / verify / reset / Formbar login flags | `server/auth.js`, `server/mail.js` | `server/db.js` accounts, `server.js` routes, `views/login.ejs` / signup / forgot / reset |
| Custom listed lobby settings | `shared/matchOptions.js`, `views/lobby-create.ejs` | `GameRoom` / `GameSim.applyMatchOptions`, `listLobbies`, `public/js/mapPreview.js` |
| Native/mobile client API | `server.js` (`/api/v1/*`, socket `auth.token`) | `test/clientApi.test.js`, Android app in pocketMOTL |
| Site pages / auth / wiki admin | `server.js` + `views/*.ejs` | `server/db.js`, `wikidocs/` |
| Suggestion / bug / wiki submit limits | `server/db.js` (`sanitizeUserText`, count/spend helpers) | `server.js` routes, `views/suggestion-modal.ejs`, `views/wiki-edit.ejs` |
| 2D visuals / HUD | `public/js/render.js`, `board.js` | `public/css/game.css` |
| 3D visuals | `public/js/scene3d.js`, `main3d.js` | `views/play3d.ejs` |
| In-match rules diagrams | `public/js/rules.js` | Must stay consistent with `shared/` + `wikidocs/` |
| Player docs | `wikidocs/` (index: `rules.md`) | Live wiki is DB-backed via `server/db.js`; keep markdown in sync when rules change |
| Product ideas / unfinished work | `goals.md` | — |

### Command / socket cheat sheet

- Client → server: `command` (payload to `sim.applyCommand`), also `leave`, `concede`, `tooltips`, `bgmVolume`, `botSettings`, `debugPlay`.
- Server → client: `state` (public snapshot), `lobby`, `go-home`, `replaced`.
- Command `type`s handled in sim: `buy`, `bank`, `targeting`, `townProduce` / `upgrade`, `order`.
- Native/client JSON API: `POST /api/v1/session`, `GET /api/v1/me`, `POST /api/v1/play` (guest modes). Socket handshake may send `auth.token` (express-session id) instead of the `lane.sid` cookie.

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
