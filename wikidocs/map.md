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
- **Footprint:** 12 paces either side. Footprints that meet are touching. Friendly blocking uses this reach.
- **Melee reach:** footprint plus 6 paces of slack either side. Same-row or adjacent-row contact inside this reach is [[Melee]]. Chargers stop just outside the hard footprint and lock in that slack ring.
- **Shooting range:** each unit has its own, measured either way along the lane. See [[Shooting]] and [[Units]].
- **Engagement range:** half of that unit's shooting range.

A unit is **ahead** of another when it is closer to the enemy keep. It is **behind** when it is closer to its own keep.

## Forts

Each player has one fort in each lane, at 200 paces from their own keep. The fort footprint is 48 paces either side of that center (twice the width of other terrain). The colored band drawn across the lane is narrower: 12 paces either side of the center.

**Cover.** A friendly unit standing in its fort footprint has 20% cover against attackers who are not also inside that same footprint. Units outside the footprint have no fort cover, including units closer to their keep than the fort. An enemy standing in your fort does not get your cover. The Keep is never protected by cover.

**Colored band.** An enemy whose center is in the colored band moves at half speed. Friendlies are not slowed by their own fort. The wider footprint does not slow movement.

**Selected unit.** While you inspect a unit standing in cover terrain, its info shows that Cover bonus.

**Line of sight.** Forts block enemy vision through them, but not your own. Standing on a fort footprint lets you see through it. Units on a fort, hill, or peak footprint are visible only if you have LOS to that footprint — intervening blockers (for example a hill before the enemy fort) still hide them.

## Terrain

Matches use a named map preset (default map below). Terrain footprints sit on specific rows and are 24 paces either side of the feature center. They are drawn over those rows. Emoji labels are off by default; turn them on in the settings menu, or see them during the training tutorial.

Cover from a footprint applies only against attackers who are not also standing in that same footprint.

**Hills** (⛰️). Block LOS. Units standing on a hill get +20% shooting range and 20% cover against attackers outside that hill. While walking away from your keep, movement is slower before the hill center and faster by the same amount after it. Walking back toward your keep reverses that: faster before the center, slower after it.

**Woods** (🌲). Units standing in woods have 10% cover against attackers outside those woods, and move slower. Standing on the woods is what removes their line-of-sight block. Guerillas in woods stay hidden unless you occupy that woods or are in melee with them (or they just shot). Other units in woods are visible through ordinary fog of war. A unit inside can see into and past the woods.

**River** (🌊). Infantry cross at half speed; cavalry at quarter speed; artillery cannot enter unless an Engineer pontoons that river (treated as a bridge while the Engineer's 60-pace aura overlaps it). Broken artillery steps onto a clear adjacent row (the bridge row when present) to keep withdrawing. Guns left on a river when a pontoon drops peel toward their own keep.

**Peaks** (🗻). Block LOS. Units standing on a peak have 30% cover against attackers outside that peak; standing on it also removes the peak's line-of-sight block. Slow infantry; cavalry and artillery cannot enter. Broken cavalry and artillery step to a clear adjacent row to keep withdrawing around the peak.

**Bridge** (🌉). Normal movement; does not block LOS (cosmetic pathing on that row).

**Fog of war.** Each row is split into segments between keeps and LOS terrain (hills, woods, peaks, forts). Rivers and bridges do not split these segments. Segments you cannot see draw dark; terrain footprints themselves are not darkened further. The server does not send you enemy unit positions you cannot see. Shots from a hidden enemy still appear in flight. Enemies you are in melee with are always shown. Guerillas are also hidden (and cannot be shot) unless within 50 paces, they shot within the last second, or you occupy their woods. Units you can see (including those on a terrain footprint you have LOS to) can be shot if they are in range. Stealthed Guerillas cannot. An Engineer within 60 paces of a terrain feature unblocks LOS through it for its side even without standing on it. Reveal and hide update each tick.

**Cresting a segment.** Once any of your units on that lane is past the centerline of the terrain that closes off a gap (and not yet into the footprint of the terrain on the far side of that gap), you can see into that open segment on every row of the lane — not only the row your unit stands on. Example: a unit on the outer bottom row just past a forest toward the river can see the inner-row gap between the peak and the next forest, but not the earlier outer-row gap between the two forests behind it.

### Default map

- **Top lane:** hill on the top two rows at one-third from the left keep; hill on the bottom two rows at one-third from the right keep.
- **Bottom lane:** forts stay at 200 paces from each keep. Between them (outer / middle / inner rows): woods and a peak on the left half; river / bridge / river at center; more woods and a peak on the right half (see the default map preset).
