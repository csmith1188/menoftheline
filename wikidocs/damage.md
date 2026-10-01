[[Damage]]
# Damage

Start from the attack's base damage. Multiply by range falloff for a shot (melee has none). Then add every attacker percentage modifier together and apply that total once. Then multiply by each defensive modifier in turn. Chop the result to two decimal places. If the result would be below zero, the hit is zero.

Range falloff is on [[Shooting]]. Melee, including charge and flank, is on [[Melee]].

Attacker percentage modifiers include the random roll of plus or minus 10%, charge, flank, troop line bonus, damage ranks, and the officer-damage bonus. Those add together into one sum.

Defensive modifiers multiply separately: defense ranks, cover, and the skirmisher's resistance to shooting. Rank 3 defense is one ×0.7 factor, not three stacked ×0.9 factors. Cover and skirmisher resistance each multiply on top of that.

- Troop line bonus: [[Units]] and [[Lines]].
- Damage ranks and defense ranks: [[Towns]].
- Cover: forts on [[The Map]].
- Skirmisher resistance, and other per-unit modifiers: [[Units]].
