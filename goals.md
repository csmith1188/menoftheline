# Bugs

# Ideas
- Total line bonus based on how perfect your line is
- fort melee bonus if enemy is not also in it
- officers make order sounds when near lines given orders
- Click, drag, long press (or rmb drag) to set a target
- Reinforced Learning player
- Game -> Client API
- Site Services -> Client API (play without ever visiting site)
- Load wiki from MDs, not database? How will it diff?
- Wiki Categories

# Feature
- no long press. click to select.
- select lines by dragging across the lane in a line
- select columns by dragging across a row in a line
- telescope mode: swipe on the green field to pan. tap to zoom out. swiping no longer switches lanes

- ~~Remove Grand Strategies?~~ (disabled; Bastion default; restore in another mode)
- Late game land?
- Add more game metrics
    Each type of game played
    Average length of game
    Tickets spent
- Music
- Game mode to play by programming each unit and keep's orders

# UI
- 3d should always zoom in to fill screen with map

# Units

# Roadmap
- terrain:
    - Blocked LOS creates fog of war in that lane (server/client comms about unit position)
    - hills -> neutral forts
    - woods -> block LoS unless inside, cover and slow
    - river -> allow infantry, blocks horse and gun
    - peaks -> block los unless inside, slow infantry, blocks horse and gun
    - bridge -> cannot switch lanes
    - fort blocks los
- Bottom Lane Units
    - Militiamen
        - Cheap troop for spam with poor endurance and discipline
    - Guerillas
        - Not shown to enemy (server side) unless within 10 paces or shot within the last second
        - Terrain ambush (always flanking when in terrain. move full speed?)
    - Light Calvary
        - Raiding towns
        - Must attack single units in packs
        - Terrain speed
    - Horse Guns. Faster, less range and damage
    - engineer unit, interacts with terrain behind it within an area
        - adds pontoons to rivers
        - can walk over mountains at half speed
        - can shoot through woods
        - can cancel fort cover
        - increases range of nearby units when on a hill