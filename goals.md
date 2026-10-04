# Bugs

# Ideas
- officers make order sounds when near lines given orders
- Reinforced Learning player
- Game -> Client API
- Site Services -> Client API (play without ever visiting site)
- Load wiki from MDs, not database? How will it diff?
- Wiki Categories
- Line select. Probably won't do because micro feels kinda good
    - could make columns good (move faster in column) and in turn, field guns
    - no long press. click to select.
    - select lines by dragging across the lane in a line
    - select columns by dragging across a row in a line
    - telescope mode: swipe on the green field to pan. tap to zoom out. swiping no longer switches lanes

# Feature

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
- Bottom Lane Units
    - Militiamen
        - Cheap troop for spam with poor damage, endurance, and discipline
    - Guerillas
        - Not shown to enemy (server side) unless within 10 paces or shot within the last second
        - Can see through woods and peaks when touching them, but cannot be seen as woods work now. Change default woods behavior to showing all units in its footprint except Guerillas.
        - Isn't slown by terrain
    - Light Calvary
        - Isn't slown by terrain, but still blocked by peaks
        - Similar to troop bonus, gets pack bonus for every other calvary in melee with units this unit is in melee with
    - Horse Guns
        - Faster, less range and damage
    - engineer unit, interacts with terrain behind it within an area
        - can see unblock LOS of terrain within officer range
        - pontoons: turns rivers within officer range into bridge
            - cannons on bridges that revert back to rivers peel back towards their own keep
        - when on a hill, passes the hill bonus to units within officer range