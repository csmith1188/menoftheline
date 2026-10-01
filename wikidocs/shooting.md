[[Shooting]]
# Shooting

A unit shoots enemies in its own lane whose centers are within its current range. Ranges are on [[The Map]]. Each unit's range is on [[Units]].

It may also shoot an enemy in the other lane when both of these are true: the path from the shooter back to its own keep, plus the path from that keep out to the target, is shorter than 200 paces; and that same path fits inside the shooter's current range.

The enemy keep can be shot only when it is the last enemy in that same lane that is not Broken. See [[Fatigue and Breaking]] and [[Units]].

- Advancing and Falling Back units use engagement range.
- Halted units use full range.
- Units do not shoot while in [[Melee]], and they do not aim at a unit that is already in melee. A shot already in the air still lands.
- Guns do not shoot in melee. They still fight in melee with their melee damage.

Which range an order uses is on [[Orders]].

Each lane has its own strategy. You change it with that lane's strategy control. The control is on [[Quick Start]]. Skirmishers and Rifles ignore it and use their own type priority instead. See [[Units]].

- **Bastion** (the default): shoot the closest target.
- **Attrition:** shoot the target with the highest remaining health percent minus fatigue percent.
- **Terror:** shoot the target with the lowest remaining health percent minus fatigue percent.

Troops, Dragoons, Guns, and Officers will not shoot an Officer while another unit type is inside the range their current order uses. Skirmishers and Rifles may shoot Officers and pick targets in this order: cavalry if it is the closest target, then other Skirmishers/Rifles, Officers, artillery, other cavalry, then Troops. A Howitzer picks the closest valid target in each row of its own lane, and will shoot an Officer in a row that has no other valid target. See [[Units]].

Shot [[Damage]] falls off with distance, down to a quarter of the hit at maximum range. Troop line bonus does not apply when the target is a Skirmisher or Rifles.

**Pushback.** Every ranged hit adds the shooter's shooting pushback to the target's pushback counter. When the counter reaches the pushback-per-pace threshold, the target owes a pace back toward its own keep. Stacked paces ease through quickly at first, then slower. If the target cannot step back because a friendly blocks it, that pace is still spent and the target gains fatigue instead. Guns and Howitzers also apply their own shooting pushback to themselves as recoil when they fire; blocked recoil does not add fatigue. Grenadiers take half of all incoming pushback. See [[Melee]], [[Fatigue and Breaking]], and [[Units]].

A Gun shell that hits a unit looks further along its path on the same row. If the next enemy footprint is within 24 paces of the struck footprint's edge, that unit is hit for half of the original blow, and a third unit may be hit for a quarter. The shell then stops. If the next unit is in melee, the shell stops without hitting it. If the aimed unit dies before the shell arrives, the shell goes to the place that unit last occupied and then continues to the next target.
