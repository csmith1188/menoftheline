# Bugs (Will fix first)
- Mobile match report flickering images

# Feature (Will add to game)
- 3d should always zoom in to fill screen with map
- Wiki Categories

# Capacity
One Node process still owns each match. `METRICS=1` and `npm run load -- bot` measure it. Sim steps stay at 50 ms; snapshots go out about every 100 ms. A crowded 20-vs-20 bench is too heavy for 100 rooms on one core (see `npm run sim-bench`), so `WORKER_COUNT` can pin each match to one owner process. That does not copy GameSim through Redis. Leave PM2 at one instance until you set workers on purpose.

# Ideas (May add to game)
- Fog in lanes in 3d
- Units also cost men from initial pool?
- Game mode to play by programming each unit and keep's orders

- Sort metrics by bot, casual, training, ranked
- Earn ranks by MMR brankets
- Vocab update

- Towns produce food/men/horses/steel? strategic capturing of towns?

- Teams battles
    - Colonel brings two battalions to the battle
    - Colonel only controls buttons, buys by battalion
    - majors are spawned for free on cooldown?
    - Majors control one battalion each
    - Line bonus capped at (3) of the same major, but can chain with battalions
    - Tax seperately and non-linearly to encourage balancing units
    - OR limited number of units per battalion

- War
    - Purchase a commission?
    - Buy a regiment. Get X battalions (number of games expected to play)
    - Pick a Battalion to enter a match
    - Battalions have limited number of specific units
    - Casualties are counted and permanent across the war
    - Events in the war can replenish them
    - or they can be restructured at a cohesion penalty
    - top players qualify for/must play higher ranked players

- regimental colours (for tickets?)

- officers make order sounds when near lines given orders
- Reinforced Learning player

# Site
- revenue goals
- don't fill formbar id's for guest / non-formbar users
- discord bot + login
- demo recorder / playback
- social accounts: x, insta, discord, reddit, restore iPhone SE
- LLC
- steam, google, apple, nintendo
- Payment processing per platform

- inspect database and migrations
- client performance benchmarks
- review performance
- redis + workers
- spawn new servers?
- reaudit security