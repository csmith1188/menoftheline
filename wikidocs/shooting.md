# Shooting

A unit shoots enemies in its own lane whose centers are within its current range **and** that have clear [[The Map|line of sight]] (terrain such as hills, woods, peaks, and enemy forts can block shots past them and hide units). A unit standing on a terrain footprint can still be shot if you can see it — that footprint does not block fire *onto* it. Ranges are on [[The Map]]. Each unit's range is on [[Units]]. Units on a hill gain +20% shooting range.

It may also shoot an enemy in the other lane when both of these are true: the path from the shooter back to its own keep, plus the path from that keep out to the target, is shorter than 200 paces; that same path fits inside the shooter's current range; and LOS is clear on the outbound leg from the keep to the target.

The enemy keep can be shot whenever it is within the shooter's current weapon range and line of sight is clear along the shooter's own row from the shooter to the keep (the keep counts as being in that row). Terrain still blocks shots *past* it the usual way, so an enemy fort between you and the keep stops fire until you pass or occupy it. For choosing which target to aim at, the keep counts as 50 paces closer than it really is; range checks and damage falloff still use the real distance. See [[Units]].

- Advancing and Falling Back units use engagement range.
- Halted units use full range. Guerillas Halted in the open only shoot inside stealth range (50 paces) unless they occupy a terrain feature.
- Units do not shoot while in [[Melee]], and they do not aim at a unit that is already in melee. The Keep is the exception: it may be shot even while friendlies are meleeing it. A shot already in the air still lands.
- Guerillas cannot be shot while stealthed (outside 50 paces, not in melee, and they have not shot in the last second). Woods still block shots at them unless you occupy that woods.
- Guns do not shoot in melee. They still fight in melee with their melee damage.

Which range an order uses is on [[Orders]].

Each unit shoots the closest eligible target (the keep uses its 50-pace priority distance when choosing). Skirmishers and Rifles use their own type priority instead. See [[Units]].

When that closest eligible target (or the best Skirmisher/Rifles priority pick) is [[The Map|In Line]] with other eligible targets in other rows, the shooter aims at the one of those whose row is closest to its own. If two share that nearest row, the closer one wins. The keep always counts as being in the shooter's row (still using its 50-pace priority distance), so row preference cannot bury a keep that would win on that ranking. Facing lines therefore tend to trade fire across rows instead of stacking every shot onto one body.

Regulars, Dragoons, Guns, and Majors will not shoot an Officer while another unit type is inside the range their current order uses. Lights and Rifles may shoot Officers and pick targets in this order: cavalry if it is the closest target, then other Skirmishers/Rifles, Officers, artillery, other cavalry, then Infantry. A Howitzer picks the closest valid target in each row of its own lane, and will shoot an Officer in a row that has no other valid target. The keep competes only in the middle row (using that same 50-pace priority), so a Howitzer volley hits it at most once. See [[Units]].

Shot [[Damage]] falls off with distance, down to a quarter of the hit at maximum range. Infantry line bonus does not apply when the target is a Light or Rifles.

**Pushback.** Every ranged hit adds the shooter's shooting pushback to the target's pushback counter. When the counter reaches the pushback-per-pace threshold, the target owes a pace back toward its own keep. Stacked paces apply one instant step per tick. If the target cannot step back because a friendly blocks it, that pace is still spent and the target gains fatigue instead. Units that are already moving toward their keep — Retreating, Falling Back, reversing on a Charge, or easing back around a friendly — do not take new pushback, and any pending pushback paces are cleared. Guns and Howitzers also apply their own shooting pushback to themselves as recoil when they fire; blocked recoil does not add fatigue. The Keep gun pushes units the same way a Field Gun does, but the Keep itself never recoils and never takes pushback. Grenadiers take half of all incoming pushback. See [[Melee]], [[Fatigue and Breaking]], and [[Units]].

A Gun shell that hits a unit looks further along its path on the same row. If the next enemy footprint is within 24 paces of the struck footprint's edge, that unit is hit for half of the original blow, and a third unit may be hit for a quarter. The shell then stops. If the next unit is in melee, the shell stops without hitting it. If the aimed unit dies before the shell arrives, the shell goes to the place that unit last occupied and then continues to the next target.
