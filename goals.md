# Bugs (Will fix first)
- easy bot doesn't buy upgraded units

# Feature (Will add to game)
- mouseover unit stats. red dot one one selected. all empty dot when line
- Move/Center Upgrade display
- 3d should always zoom in to fill screen with map
- Fog in lanes in 3d
- gun puffs
- Late game land?
- ~~Add more game metrics~~ (`/admin/analytics`: modes, duration, tickets via ledger)
- Game mode to play by programming each unit and keep's orders
- Wiki Categories

# Capacity

One Node process still owns each match. `METRICS=1` and `npm run load -- bot` measure it. Sim steps stay at 50 ms; snapshots go out about every 100 ms. A crowded 20-vs-20 bench is too heavy for 100 rooms on one core (see `npm run sim-bench`), so `WORKER_COUNT` can pin each match to one owner process. That does not copy GameSim through Redis. Leave PM2 at one instance until you set workers on purpose.

# Ideas (May add to game)
- officers make order sounds when near lines given orders
- Reinforced Learning player
- ~~Electron + Capacitor packaging~~ (`platforms/*`, `docs/packaging.md`)
- ~~Retire pocketMOTL Kotlin client~~ (Capacitor + `motl://auth`; Desktop folder kept as archive)

# Site
- revenue goals
- account deletion
- delete your own bug reports
- don't fill formbar id's for guest / non-formbar users
- news mailer
- discord bot
- demo recorder / playback
- refund based on purchase type (5/20/50)

- social accounts: x, insta, discord, reddit, restore iPhone SE
- LLC
- steam, google, apple, nintendo
- Payment processing per platform

- review performance
- redis + workers
- spawn new servers?
- reaudit security