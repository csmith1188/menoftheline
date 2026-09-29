# Men of the Line

Two players each defend a keep. Destroy the enemy keep to win. The game can be played through any client: the match only reports positions, orders, and results.

## The map

There are two lanes, Top and Bottom. Each lane is a line of paces with parallel rows.

- The Top lane is 1000 paces long and has five rows.
- The Bottom lane is 1500 paces long and has three rows.
- Every row is the full length of its lane.
- An adjacent row is the next row over. You cannot skip a row.
- Both lanes start at the center of one keep and end at the center of the other.

The Bottom lane is drawn as an arc so the lanes can meet at both keeps. Units on an inner ring cover the same paces in fewer pixels, so they look slower. That difference is only visual. Every row of a lane takes the same time to cross.

Distances along a lane are measured from a unit's center. Each figure below is a **reach from that center**. Two units match when those reaches **overlap** (so centers may be up to twice the reach apart):

- **Perfect Line:** 1 pace either side.
- **In Line:** 8 paces either side.
- **Footprint:** 12 paces either side. Footprints that meet are touching.
- **Shooting range:** each unit has its own, measured either way along the lane.
- **Engagement range:** half of that unit's shooting range.

A unit is **ahead** of another when it is closer to the enemy keep. It is **behind** when it is closer to its own keep.

### Forts

Each player has one fort in each lane, at 250 paces from their own keep. A unit whose footprint reaches its own fort in that lane has cover. Cover reduces incoming damage by 20%.

### Towns

The Bottom lane has five towns, spaced evenly along the lane. The last player to move a unit past a town owns it. Owning a town lets you spend land on its upgrade. Click a town you own to start or stop that research. Two towns of the same upgrade pay into the same research at once.

From either end the towns are Defense, Speed, Damage, Speed, Defense. Research spends 1 land per second until the rank is paid for. Each rank costs the same land price. There are five ranks.

- **Defense** reduces damage taken by 10% per rank.
- **Speed** increases move speed and charge speed by 10% per rank. Shooting and melee reload 5% faster per rank.
- **Damage** increases melee and shooting damage by 10% per rank.

Ranks of the same upgrade add together. Rank 3 is one +30% modifier, not three separate +10% multipliers.

## The middle line

Each lane has a middle line.

For each unit that is not Broken, multiply its remaining health by how far it has marched from its own keep, as a fraction from 0 to 1. Add your units. Add the enemy's units. Your share is your total divided by both totals. The line sits at that share of the lane, measured from your keep. If neither side has any value, the line stays at the halfway point.

Gold and land use this share immediately. A client may slide the drawn line toward the new place. The income numbers follow the share, not the drawing.

## Lines

When you select a unit, it looks in adjacent rows for units of the same type that are In Line. Those units look in their other adjacent rows, and so on, until the chain stops. That group is a line. Broken units are never part of a line.

If two units in the same adjacent row both qualify, the one whose center is closer is the one in the line.

An order given to a unit is also given to the rest of its line. The unit you touched is the selected unit. The others are subselected. A long press selects only that unit. Later orders stay on it alone until you give an order to a different unit.

## Orders

A unit is always under one order. Advance is the order units start with.

**Advance.** The unit marches forward. It shoots at engagement range, then keeps marching when it has nothing to shoot. In a line that is already Perfect Line, once any mate has opened fire the others that are Perfect Line with it hold and shoot with it. Units still closing up keep marching. Advance does not stop or dress the line just to square it when nobody is shooting.

**Halt.** The unit stops and shoots at full range. It recovers fatigue over time.

**Charge.** The unit rushes forward at charge speed, seeking melee, and does not shoot until it is in contact. It ignores friendly footprints. It gains fatigue while it moves. A charge hit in melee gains the unit's charge bonus. Charge does not end when fatigue is full.

**Fall Back.** The unit moves backward at half speed and ignores friendly footprints. It may shoot at engagement range, but reloads at half speed. Skirmishers reload at full speed.

**Retreat.** The unit moves backward at charge speed and ignores friendly footprints. It gains fatigue while it moves, and Falls Back when the fatigue bar is full. You cannot order Retreat yourself. Broken units Retreat on their own.

**Reform.** The furthest-forward units in the line stop. The furthest-back units move at full speed. Everyone else moves at half speed. Units walk up until they match the front's place along the lane — they do not snap into place. When the whole line is level with the front, every unit Halts. Reform only recruits same-type units on adjacent rows that are In Line; an empty row still splits the chain.

**Switch row.** This does not replace the current order. Swiping a line that is not yet squared Reforms it first, then moves one adjacent row once the line is square. A line that is already squared moves one adjacent row immediately. A long-pressed unit moves alone, still only one row. If the adjacent row in the swipe direction already holds a matching unit that is In Line, the line Reforms instead and does not queue a row change. While finding a gap, units ignore friendly footprints and keep going in the same along-lane direction until the row is open. If one end of the line must ease forward or back around a unit that is not part of the shift, the whole line eases the same way with it until that row is clear, then they all change rows together. A new order cancels the switch. A unit in melee cannot switch.

### Melee orders

A unit in melee keeps its order. The only order you may give it is Fall Back, and that Fall Back applies to that unit alone. When a unit that is not Charging leaves melee because the enemy is no longer in reach, it Halts. A unit that would enter melee while overlapping a friendly already in melee peels away and returns to Advance.

## Shooting

A unit shoots enemies in its own lane whose centers are within its current range.

It may also shoot an enemy in the other lane when both of these are true: the path from the shooter back to its own keep, plus the path from that keep out to the target, is shorter than 200 paces; and that same path fits inside the shooter's current range.

The enemy keep can be shot only when it is the last enemy in that same lane that is not Broken.

- Advancing and Falling Back units use engagement range.
- Halted units use full range.
- Skirmishers use full range whenever they are allowed to fire.
- Units do not shoot while in melee, and they do not aim at a unit that is already in melee. A shot already in the air still lands.
- Guns do not shoot in melee. They can fight in melee for 1 damage.

Each lane has its own strategy. You change it with that lane's strategy control.

- **Bastion** (the default): shoot the closest target.
- **Attrition:** shoot the target with the highest remaining health percent minus fatigue percent.
- **Terror:** shoot the target with the lowest remaining health percent minus fatigue percent.

Troops, Dragoons, Guns, and Officers will not shoot an Officer while another unit type is inside the range their current order uses. Skirmishers may shoot Officers. A Howitzer picks the closest valid target in each row of its own lane, and will shoot an Officer in a row that has no other valid target.

Shot damage falls off with distance, down to a quarter of the hit at maximum range.

A Gun shell that hits a unit looks further along its path. If the next enemy footprint is within 3 paces of the struck footprint, that unit is hit for half of the original blow, and a third unit may be hit for a quarter. The shell then stops. If the next unit is in melee, the shell stops without hitting it. If the aimed unit dies before the shell arrives, the shell goes to the place that unit last occupied and then continues to the next target.

## Melee

Footprints that overlap on the same row, or on an adjacent row, are in melee. Both sides strike with their melee speed and melee damage.

A charging unit gets its charge bonus on those hits. It also gets its flank bonus when it is on the adjacent row, or on the same row and behind its target. Only the charger gains the flank bonus. Grenadiers do not take extra damage from a flank. Dragoons use a larger flank bonus. Lancers use a normal flank bonus and a larger charge bonus.

## Damage

Start from the attack's base damage. Multiply by range falloff for a shot (melee has none). Then add every percentage modifier together and apply that total once. Chop the result to two decimal places. If the modifiers would reduce the hit below zero, the hit is zero.

Percentage modifiers include the random roll of plus or minus 10%, charge, flank, troop line bonus, damage ranks, defense ranks, cover, and the skirmisher's resistance to shooting.

Troops gain a line bonus on shooting only: +20% for each other troop in the line that is not in melee and can see a target under its current order. Four eligible troops are +60% for each of them.

## Fatigue and breaking

Every unit starts with an empty fatigue bar that fills at 100.

- A melee swing adds 2 fatigue.
- Being hit in melee adds 2 fatigue.
- Being shot adds 2 fatigue.
- Charging, Retreating, or standing in melee adds fatigue over time.
- Halting removes fatigue over time.
- Your keep restores fatigue and health. See Officers below.

When a unit is hit, roll from 1 to 100. If the roll is less than its fatigue percent minus its remaining health percent, it becomes Broken.

A Broken unit takes no orders. It Retreats until fatigue is full, then Falls Back. It recovers fatigue while it is not Retreating. It stops being Broken, and returns to Advance, when its fatigue is at or below half of its current health.

## Units

Each unit has its own health, ranges, damage, and speeds. Each type has an alternate that counts as the same type for forming a line, with its own name, numbers, and ability.

**Troop.** Gains the line bonus above. Grenadiers are tougher and do not take extra damage from flanks.

**Skirmisher.** May fire at full range and full reload whenever firing is allowed, including while Falling Back. Takes half damage from shooting. Rifles deal double damage to Officers.

**Dragoon.** A larger flank bonus while charging and flanking. Lancers keep a normal flank bonus and use a 1.8× charge bonus.

**Gun.** A hit can strike up to two more units behind the first, as described under Shooting. Howitzers instead fire at one target in every row of their lane.

**Officer.** Troops, Dragoons, Guns, and Officers avoid shooting Officers while another unit type is in range. An Officer restores fatigue to friends within 10 paces on every row of its lane. The restore is doubled for friends behind the Officer. A second Officer does not add more; only the stronger restore applies.

**Color Guard.** An Officer that also restores health in that same area, doubled the same way. Color Guards do not stack with each other. One Officer and one Color Guard do stack.

**Keep.** Each player starts with a keep. It does not move, take orders, or get built. It sits at the end of every row of both lanes. It shoots, and it can shoot a unit that is in melee. If your keep is destroyed, you lose.

Within 20 paces of your keep, friends gain the equivalent of three Color Guard restores. From 20 to 40 paces, two. From 40 to 60 paces, one. Beyond 60, none. This does not double again for being behind the keep, and it stacks with one Officer and one Color Guard.

## Gold, land, and banks

Each player starts with 600 gold and 0 land.

- Gain 10 gold per second.
- Gain up to 10 more gold per second, multiplied by your share of the Top middle line. A 60% share pays 6 gold per second.
- Gain up to 10 land per second, multiplied by your share of the Bottom middle line.
- Pay upkeep each second: half a percent of the gold cost of each unit you control, scaled by that unit's remaining health.

Each player has three banks, locked at the start. A bank costs a starting price plus extra gold for each bank already open. Banks become available at the start of the match, at 2 minutes, and at 4 minutes. Each new bank adds more gold per second than the last: the first adds 3, the second adds 6, and the third adds 9.

Alternates cost land as well as gold. Basic units cost gold only.

## Giving orders

Touching a unit selects it and subselects the rest of its line, then gives the order to all of them.

- Click a unit to Halt. Click a Halted unit to Advance.
- Swipe toward the enemy keep to Charge.
- Swipe toward your keep to Fall Back.
- Swipe up or down to change rows. A staggered line Reforms first, then switches when it is square. A squared line switches immediately.
- Long press a unit to deselect every other unit. Orders given to it are not passed along the line until you order a different unit.

To Reform without stacking onto a neighbor, swipe toward a clear adjacent row while the line is still staggered — the line squares, then switches. Swiping onto a matching unit that is already In Line Reforms instead, and does not change rows.