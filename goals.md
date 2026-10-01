# Bugs
- How does passing friendly blocking units work and when?
- Do a lookover of unused code

# Ideas
- officers make order sounds when near lines given orders
- column. faster move in matching in line in same row.
- change auto-orders, in python
- Click, drag, long press (or rmb drag) to set a target
- Reinforced Learning player
- Game -> Client API
- Site Services -> Client API (play without ever visiting site)

# Feature
- deeper cannon sounds
- Load wiki from MDs, not database? How will it diff?
- Wiki Categories
- Add more game metrics
    Each type of game played
    Average length of game
    Tickets spent
- Music

# UI
- 3d should always zoom in to fill screen with map
- draw everything in canvas and take full screen

# Roadmap
- terrain:
    - hills -> neutral forts
    - woods -> block LoS unless inside, cover and slow
    - river -> allow infantry, blocks horse and gun
    - peaks -> block los unless inside, slow infantry, blocks horse and gun
    - bridge -> cannot switch lanes
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