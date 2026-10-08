# Men Of The Line

A real-time strategy game where two players defend a keep and try to destroy the enemy’s. You build units, push lanes for gold and land, and issue orders to lines of troops.

---

## For players

You do not need to install anything to play if someone is already hosting the site.

1. Open the site in a modern browser (phone or desktop).
2. Go to **Games**.
3. Choose a mode:
   - **Play vs bot** — practice alone
   - **Random unranked** — quick match against another player
   - **Create lobby / Find ranked** — needs a free ticket (sign in if your host uses Formbar login)
4. Destroy the enemy keep to win.

**Basics in a match**

- Swipe unit buttons up/down to buy for the top/bottom lane; left/right to change unit type.
- Click a unit to Halt; click again to Advance.
- Swipe forward to Charge, back to Fall Back, up/down to shift rows.
- Click banks to buy them; click towns you control to toggle research.

In-game **How to play** and the site wiki have more detail.

---

## For developers

### Requirements

- [Node.js](https://nodejs.org/) 18+ (20+ recommended)
- npm (comes with Node)

### Setup

```bash
git clone https://github.com/csmith1188/menoftheline.git
cd menoftheline
npm install
cp .env.template .env
```

Edit `.env` if needed. For local play, the defaults are usually enough:

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port (default `3000`) |
| `SESSION_SECRET` | Cookie/session secret |
| `THIS_URL` | Public URL of this app (e.g. `http://localhost:3000`) |
| `AUTH_URL` | Formbar auth host (optional for guest/bot play) |
| `API_KEY` / `POOL_ID` / `POOL_PIN` | Formbar payments/rewards (optional) |
| `LOG_LEVEL` | Pino level (`info` default; use `debug` for gameplay diagnostics) |

Server logging (Pino, PM2 paths, searching by `matchId`/`userId`): see [docs/logging.md](docs/logging.md).

SQLite data is stored under `data/` (created at runtime; ignored by git except `data/news.json`).

### Run

```bash
npm start          # production-style: node app.js
npm run dev        # auto-restart with nodemon (install nodemon if needed)
npm test           # run unit tests
```

Open `http://localhost:3000` (or your `PORT`).

### Native client API

Guest Android/desktop clients can start matches without website cookies:

- `POST /api/v1/session` with optional `{ "name" }` → `{ token, player }`
- `GET /api/v1/me` with `Authorization: Bearer <token>` → `{ player, busy }`
- `POST /api/v1/play` with `{ "mode": "bot" | "trainBot" | "casual" | "trainCasual" }` → `{ ok, mode }`
- Socket.IO handshake `auth.token` uses that same session id

Ranked / listed / join still require Formbar login on the website (`login_required`).

### Project layout

| Path | Role |
| --- | --- |
| `app.js` | Express app, routes, Socket.IO |
| `server/` | DB, matchmaking, simulation, auth helpers |
| `shared/` | Shared game config and unit data |
| `public/` | Static CSS/JS/assets |
| `views/` | EJS pages |
| `wikidocs/` | Wiki source markdown |
| `test/` | Node test suite |

Guest and bot matches work without Formbar credentials. Ranked/lobby tickets and Digipog rewards need a configured Formbar `API_KEY` and pool settings.
