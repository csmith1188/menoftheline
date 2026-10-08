# Bugs (Will fix first)
- easy bot doesn't buy upgraded units

# Feature (Will add to game)
- mouseover unit stats. red dot one one selected. all empty dot when line
- Move/Center Upgrade display
- 3d should always zoom in to fill screen with map
- Fog in lanes in 3d
- gun puffs
- Late game land?
- Add more game metrics
    Each type of game played
    Average length of game
    Tickets spent
- Game mode to play by programming each unit and keep's orders

# Capacity

One Node process still owns each match. `METRICS=1` and `npm run load -- bot` measure it. Sim steps stay at 50 ms; snapshots go out about every 100 ms. A crowded 20-vs-20 bench is too heavy for 100 rooms on one core (see `npm run sim-bench`), so `WORKER_COUNT` can pin each match to one owner process. That does not copy GameSim through Redis. Leave PM2 at one instance until you set workers on purpose.

# Ideas (May add to game)
- officers make order sounds when near lines given orders
- Reinforced Learning player
- ~~Game -> Client API~~ (`/api/v1` session/me/play + socket `auth.token`)
- ~~Site Services -> Client API (play without ever visiting site)~~ (Formbar login, tickets, ranked/listed/join, lobbies)
- Load wiki from MDs, not database? How will it diff?
- Wiki Categories

- Admin account
- don't fill formbar id's for guest / non-formbar users
- ticket transaction tracking
- player report
- demo recorder/playback