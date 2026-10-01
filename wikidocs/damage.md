# Damage

Start from the attack's base damage. Multiply by range falloff for a shot (melee has none). Then add every attacker percentage modifier together and apply that total once. Then multiply by each defensive modifier in turn. Chop the result to two decimal places. If the result would be below zero, the hit is zero.

Range falloff is on [[Shooting]]. Melee, including charge and flank, is on [[Melee]].

Attacker percentage modifiers include the random roll of plus or minus 10%, charge, flank, troop line bonus, damage ranks, and the officer-damage bonus. Those add together into one sum. Troop line bonus is skipped when the target is a Skirmisher or Rifles. Damage ranks apply to units only; the Keep gun does not use them. Units that attack the Keep still use their own damage ranks.

Defensive modifiers multiply separately: defense ranks and cover. Rank 3 defense is one ×0.7 factor, not three stacked ×0.9 factors. Cover multiplies on top of that. Defense ranks apply to units only; hits on the Keep are not reduced by Defense research. Cover does not protect the Keep.

- Troop line bonus: [[Units]] and [[Lines]].
- Damage ranks and defense ranks: [[Towns]].
- Cover: forts on [[The Map]].
- Per-unit modifiers (including Rifles vs Officers): [[Units]].
