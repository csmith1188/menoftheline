[[The Map]]
# The Map

There are two lanes, Top and Bottom. Each lane is a line of paces with parallel rows.

- The Top lane is 1000 paces long and has five rows.
- The Bottom lane is 1500 paces long and has three rows. The [[Towns]] are on this lane.
- Every row is the full length of its lane.
- An adjacent row is the next row over. You cannot skip a row.
- Both lanes start at the center of one keep and end at the center of the other.

The Bottom lane is drawn as an arc so the lanes can meet at both keeps. Units on an inner ring cover the same paces in fewer pixels, so they look slower. That difference is only visual. Every row of a lane takes the same time to cross.

Distances along a lane are measured from a unit's center. Each figure below is a **reach from that center**. Two units match when those reaches **overlap** (so centers may be up to twice the reach apart):

- **Perfect Line:** 1 pace either side. [[Orders]] use this when a line holds to shoot, and for Troop order passing.
- **In Line:** 8 paces either side. [[Lines]] form inside this reach.
- **Footprint:** 12 paces either side. Footprints that meet are touching. Friendly blocking and the fort's cover zone use this reach.
- **Melee reach:** footprint plus 6 paces of slack either side. Same-row or adjacent-row contact inside this reach is [[Melee]]. Chargers stop just outside the hard footprint and lock in that slack ring.
- **Shooting range:** each unit has its own, measured either way along the lane. See [[Shooting]] and [[Units]].
- **Engagement range:** half of that unit's shooting range.

A unit is **ahead** of another when it is closer to the enemy keep. It is **behind** when it is closer to its own keep.

## Forts

Each player has one fort in each lane, at 250 paces from their own keep. The fort's cover zone uses the same footprint reach as units (12 paces either side of the fort center).

**Cover.** A unit at or behind its own fort (footprint on the fort, or closer to its keep) has cover against attackers who are past that fort — outside the fort footprint, toward the enemy. Attackers standing in the fort or behind it with you do not grant cover. Cover reduces incoming [[Damage]] by 20%. The Keep is never protected by cover.

**Selected unit.** While you inspect a unit at or behind its fort, its info shows Cover when no enemy stands at or behind either of your forts (the same clear-fort check that allows keep health restore).

**Line of sight.** Forts block enemy vision through them, but not your own. Standing on a fort footprint lets you see through it. Units on a fort, hill, or peak footprint are visible only if you have LOS to that footprint — intervening blockers (for example a hill before the enemy fort) still hide them.

## Terrain

Matches use a named map preset (default map below). Terrain footprints sit on specific rows and use the same footprint reach as forts (12 paces either side of the feature center). They are drawn over those rows. Emoji labels are off by default; turn them on in the settings menu, or see them during the training tutorial.

**Hills** (⛰️). Block LOS. Units on a hill get +20% shooting range and fort-style cover against attackers off that hill. Movement is slower before the hill center (from your keep) and faster by the same amount after it.

**Woods** (🌲). Hide units inside unless you also have a unit in that woods. A unit inside can see into and past the woods. Units in woods have cover. All units move slower in woods.

**River** (🌊). Infantry cross at half speed; cavalry at quarter speed; artillery cannot enter.

**Peaks** (🗻). Block LOS. Slow infantry; cavalry and artillery cannot enter.

**Bridge** (🌉). Normal movement; does not block LOS (cosmetic pathing on that row).

**Fog of war.** Each row is split into segments between keeps and LOS terrain (hills, woods, peaks, forts). Rivers and bridges do not split these segments. Segments you cannot see draw dark; terrain footprints themselves are not darkened further. The server does not send you enemy unit positions you cannot see. Enemies you are in melee with are always shown. Units you can see (including those on a terrain footprint you have LOS to) can be shot if they are in range. Reveal and hide update each tick.

**Cresting a segment.** Once any of your units on that lane is past the centerline of the terrain that closes off a gap (and not yet into the footprint of the terrain on the far side of that gap), you can see into that open segment on every row of the lane — not only the row your unit stands on. Example: a unit on the outer bottom row just past a forest toward the river can see the inner-row gap between the peak and the next forest, but not the earlier outer-row gap between the two forests behind it.

### Default map

- **Top lane:** hill on the top two rows at one-third from the left keep; hill on the bottom two rows at one-third from the right keep.
- **Bottom lane:** forts stay at 250 paces from each keep. Between them (outer / middle / inner rows): woods and a peak on the left half; river / bridge / river at center; more woods and a peak on the right half (see the default map preset).
