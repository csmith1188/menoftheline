# Damage

Start from the attack's base damage. Multiply by range falloff for a shot (melee has none). Then add every attacker percentage modifier together and apply that total once. Then multiply by each defensive modifier in turn. Chop the result to two decimal places. If the result would be below zero, the hit is zero.

Range falloff is on [[Shooting]]. Melee, including charge and flank, is on [[Melee]].

Attacker percentage modifiers include the random roll of plus or minus 10%, charge, flank, infantry line bonus, damage ranks, missing-health loss, and the officer-damage bonus. Those add together into one sum. Infantry line bonus stacks from eligible line-mates, then scales with how Perfect the shooter is with its adjacent-row neighbors (full in Perfect Line, nearly none at the In Line edge). For shots, that line term is measured when the shell lands (after pushback), not when it was fired. Infantry line bonus is skipped when the target is a Light or Rifles. Damage ranks apply to units only; the Keep gun does not use them. Units that attack the Keep still use their own damage ranks.

**Missing health.** A unit deals less damage as it loses health: each 2% of health missing costs 1% damage. A unit at half health deals 25% less damage. Friends inside a Color Guard restore aura ignore this loss and strike at full strength. See [[Units]].

Defensive modifiers multiply separately: defense ranks and cover. Rank 3 defense is one ×0.7 factor, not three stacked ×0.9 factors. Cover multiplies on top of that. Defense ranks apply to units only; hits on the Keep are not reduced by Defense research. Cover does not protect the Keep.

**Cover.** Cover applies while the defender's centerline is inside a footprint, and only against an attacker who is not inside that same footprint. A friendly fort is a ×0.8 factor. Hills are a ×0.8 factor. Woods are a ×0.9 factor. Peaks are a ×0.7 factor. An enemy standing in your fort does not receive your fort's cover. Full geometry is on [[The Map]].

- Infantry line bonus: [[Units]] and [[Lines]].
- Damage ranks and defense ranks: [[Towns]].
- Cover: forts, hills, woods, and peaks on [[The Map]].
- Per-unit modifiers (including Rifles vs Officers): [[Units]].
