import { CONFIG } from "./config.js";

/**
 * Canonical stats for each unit kind. The server unit classes copy these
 * onto each instance. Keys match the spawn type. Alternates keep their
 * base `type` in play (troop, skirmisher, …) and carry a `variant` id.
 *
 * shootingPushback / meleePushback accumulate on the target's pushback
 * counter (melee pushback only from Charge). pushbackTakenFactor scales
 * incoming pushback (grenadiers take half).
 * engageRange is the fraction of range at which the unit opens fire on its own.
 * chargeSpeed is the walk multiplier while charging (1 = no bonus).
 * fatigue is the max fatigue pool (breaks when fatigue % exceeds hp %).
 * chargeMultiplier and flankMultiplier apply to outgoing damage.
 * officerDamageMultiplier scales damage when hitting an officer.
 */
/** Troop musket balls (and troop variants). */
const PROJECTILE_COLOR_TROOP = "#f3d27a";
/** Non-troop small arms (skirmisher, dragoon, officer, …). */
const PROJECTILE_COLOR_OTHER = "#fff3b0";
/** Cannon / howitzer / horse gun / keep shells. */
const PROJECTILE_COLOR_CANNON = "#ff8a28";

const SHOT = {
  shootingPushback: 1,
  meleePushback: 2,
  pushbackTakenFactor: 1,
  chargeMultiplier: 1.2,
  projectileSize: 4,
  projectileSpeed: 220,
  projectileColor: PROJECTILE_COLOR_TROOP,
  radius: 10,
  fatigue: 100,
};
export const UNIT_STATS = {
  troop: {
    ...SHOT,
    hp: 200,
    rangedDamage: 10,
    meleeDamage: 10,
    range: 200,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 1.5,
    meleeCooldown: 1.5,
    speed: 15,
    cost: 150,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
  },
  skirmisher: {
    ...SHOT,
    hp: 100,
    rangedDamage: 6,
    meleeDamage: 6,
    range: 200,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 1,
    meleeCooldown: 1.5,
    speed: 15,
    cost: 100,

    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    shootingPushback: 2,
    projectileColor: PROJECTILE_COLOR_OTHER,
  },
  dragoon: {
    ...SHOT,
    hp: 200,
    rangedDamage: 10,
    meleeDamage: 20,
    range: 200,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.8,
    rangedCooldown: 1.5,
    meleeCooldown: 1.5,
    speed: 25,
    cost: 200,

    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    projectileColor: PROJECTILE_COLOR_OTHER,
  },
  cannon: {
    ...SHOT,
    hp: 100,
    rangedDamage: 120,
    meleeDamage: 5,
    range: 300,
    engageRange: 0.5,
    chargeSpeed: 1.2,
    flankMultiplier: 1.2,
    rangedCooldown: 6,
    meleeCooldown: 6,
    speed: 12,
    cost: 400,

    fightsMelee: true,
    splash: 0.5,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    projectileColor: PROJECTILE_COLOR_CANNON,
  },
  officer: {
    ...SHOT,
    hp: 50,
    rangedDamage: 5,
    meleeDamage: 5,
    range: 100,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 1.5,
    meleeCooldown: 1.5,
    speed: 15,
    cost: 300,

    fightsMelee: true,
    splash: 0,
    restoreRange: 100,
    restoreRate: 2,
    restoreHealth: true,
    officerDamageMultiplier: 1,
    projectileColor: PROJECTILE_COLOR_OTHER,
  },
  // Alternates (same base type in play). Elite: yellow square. Light: white square.
  /** Troop with more hit points; takes half pushback; stronger melee push. */
  grenadier: {
    ...SHOT,
    hp: 250,
    rangedDamage: 10,
    meleeDamage: 10,
    range: 200,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 1.5,
    meleeCooldown: 1.5,
    speed: 15,
    cost: 200,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    meleePushback: 1.5,
    pushbackTakenFactor: 0.5,
  },
  /** Skirmisher: longer shot, harder hit, slower reload. */
  rifle: {
    ...SHOT,
    hp: 100,
    rangedDamage: 15,
    meleeDamage: 10,
    range: 220,
    engageRange: 1,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 2,
    meleeCooldown: 1.5,
    speed: 15,
    cost: 150,

    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 2,
    shootingPushback: 1,
    projectileColor: PROJECTILE_COLOR_OTHER,
  },
  /** Dragoon: normal flank multiplier, stronger charge hits and melee push. */
  lancer: {
    ...SHOT,
    hp: 200,
    rangedDamage: 10,
    meleeDamage: 20,
    range: 100,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    chargeMultiplier: 1.8,
    rangedCooldown: 1.5,
    meleeCooldown: 1.5,
    speed: 25,
    cost: 200,

    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    meleePushback: 4,
    projectileColor: PROJECTILE_COLOR_OTHER,
  },
  /** Cannon: shorter reach, cannister — one shell per in-range row, no splash. */
  howitzer: {
    ...SHOT,
    hp: 200,
    rangedDamage: 90,
    meleeDamage: 10,
    range: 200,
    engageRange: 0.5,
    chargeSpeed: 1,
    flankMultiplier: 1.2,
    rangedCooldown: 6,
    meleeCooldown: 6,
    speed: 15,
    cost: 500,

    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    projectileColor: PROJECTILE_COLOR_CANNON,
  },
  /**
   * Officer alternate: same fatigue/health restore as an Officer (half the
   * old Color Guard rate). Friends in its aura ignore missing-health damage loss.
   */
  colorGuard: {
    ...SHOT,
    hp: 50,
    rangedDamage: 5,
    meleeDamage: 5,
    range: 100,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 1.5,
    meleeCooldown: 1.5,
    speed: 15,
    cost: 500,

    fightsMelee: true,
    splash: 0,
    restoreRange: 100,
    restoreRate: 2,
    restoreHealth: true,
    officerDamageMultiplier: 1,
    projectileColor: PROJECTILE_COLOR_OTHER,
  },
  militia: {
    ...SHOT,
    hp: 100,
    rangedDamage: 8,
    meleeDamage: 8,
    range: 200,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 1.5,
    meleeCooldown: 1.5,
    speed: 15,
    cost: 75,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    fatigue: 60,
    pushbackTakenFactor: 1.5,
  },
  guerrilla: {
    ...SHOT,
    hp: 100,
    rangedDamage: 7,
    meleeDamage: 7,
    range: 220,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 1,
    meleeCooldown: 1.5,
    speed: 15,
    cost: 100,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    shootingPushback: 2,
    ignoreTerrainSlow: true,
    projectileColor: PROJECTILE_COLOR_OTHER,
  },
  hussar: {
    ...SHOT,
    hp: 100,
    rangedDamage: 10,
    meleeDamage: 10,
    range: 100,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 1.5,
    meleeCooldown: 1.5,
    speed: 25,
    cost: 200,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    ignoreTerrainSlow: true,
    projectileColor: PROJECTILE_COLOR_OTHER,
  },
  horseGun: {
    ...SHOT,
    hp: 100,
    rangedDamage: 90,
    meleeDamage: 10,
    range: 250,
    engageRange: 0.5,
    chargeSpeed: 1,
    flankMultiplier: 1.2,
    rangedCooldown: 6,
    meleeCooldown: 6,
    speed: 20,
    cost: 300,
    fightsMelee: true,
    splash: 0.5,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    projectileColor: PROJECTILE_COLOR_CANNON,
  },
  engineer: {
    ...SHOT,
    hp: 50,
    rangedDamage: 5,
    meleeDamage: 5,
    range: 100,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 1.5,
    meleeCooldown: 1.5,
    speed: 15,
    cost: 200,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    restoreHealth: false,
    officerDamageMultiplier: 1,
    projectileColor: PROJECTILE_COLOR_OTHER,
  },
};
export function unitStats(type) {
  return UNIT_STATS[type] || UNIT_STATS.troop;
}

/** Terrain mobility: infantry / cavalry / artillery. */
const MOBILITY_CLASS = {
  troop: "infantry",
  grenadier: "infantry",
  militia: "infantry",
  skirmisher: "infantry",
  rifle: "infantry",
  guerrilla: "infantry",
  officer: "infantry",
  colorGuard: "infantry",
  engineer: "infantry",
  dragoon: "cavalry",
  lancer: "cavalry",
  hussar: "cavalry",
  cannon: "artillery",
  howitzer: "artillery",
  horseGun: "artillery",
};

/** Mobility class for terrain rules (river/peak/etc.). */
export function mobilityClass(type) {
  return MOBILITY_CLASS[type] || "infantry";
}

/** Base buy type → yellow (elite) then white (light) alternate spawn keys. */
export const UNIT_VARIANTS = {
  troop: ["grenadier", "militia"],
  skirmisher: ["rifle", "guerrilla"],
  dragoon: ["lancer", "hussar"],
  cannon: ["howitzer", "horseGun"],
  officer: ["colorGuard", "engineer"],
};

/** Alternate spawn key → base buy type. */
export const VARIANT_OF_BASE = {};
for (const [base, alts] of Object.entries(UNIT_VARIANTS)) {
  for (let i = 0; i < alts.length; i += 1) {
    VARIANT_OF_BASE[alts[i]] = base;
  }
}

/** Spawn keys shown on a buy button: base, then each alternate. */
export function variantOptions(base) {
  const alts = UNIT_VARIANTS[base];
  if (!alts || !alts.length) return [base];
  return [base, ...alts];
}

/** Next spawn key when swiping a buy button. dir is -1 left or +1 right. */
export function cycleVariantPick(base, current, dir) {
  const options = variantOptions(base);
  let idx = options.indexOf(current);
  if (idx < 0) idx = 0;
  const n = options.length;
  const step = dir < 0 ? -1 : 1;
  return options[(idx + step + n) % n];
}

/** True when `type` is an alternate spawn key (grenadier, rifle, …). */
export function isAlternateUnit(type) {
  return Boolean(VARIANT_OF_BASE[type]);
}

/** True when `type` is the light (white) alternate of its base. */
export function isLightAlternate(type) {
  const base = VARIANT_OF_BASE[type];
  if (!base) return false;
  const alts = UNIT_VARIANTS[base] || [];
  return alts[1] === type;
}

/** Badge fill behind an alternate silhouette, or null for base units. */
export function variantBadgeFill(type) {
  if (isLightAlternate(type)) return CONFIG.colors.whiteAlternate;
  if (isAlternateUnit(type)) return CONFIG.colors.yellowAlternate;
  return null;
}

/**
 * Land price to buy an alternate. Bases cost 0 land.
 * Light (white) alternates use lightUnitLandCostRatio; elite (yellow) use unitLandCostRatio.
 * stats.landCost overrides either ratio.
 */
export function unitLandCost(type) {
  if (!isAlternateUnit(type)) return 0;
  const stats = unitStats(type);
  if (stats.landCost != null) return stats.landCost;
  const ratio = isLightAlternate(type)
    ? CONFIG.lightUnitLandCostRatio
    : CONFIG.unitLandCostRatio;
  return Math.round(stats.cost * ratio);
}

/**
 * Gold drained per second for the units on the field.
 * Each living unit pays massTaxRate of its gold cost (full cost, not scaled by HP).
 */
export function massTaxOf(troops) {
  if (!troops) return 0;
  let tax = 0;
  const rate = CONFIG.massTaxRate;
  for (let i = 0; i < troops.length; i += 1) {
    const troop = troops[i];
    if (!troop || troop.hp <= 0) continue;
    const stats = unitStats(troop.variant || troop.type);
    tax += stats.cost * rate;
  }
  return tax;
}

/** Short labels for buy buttons and inspect text. */
export const UNIT_LABELS = {
  troop: "Troop",
  skirmisher: "Skirmisher",
  dragoon: "Dragoon",
  cannon: "Field Gun",
  officer: "Officer",
  grenadier: "Grenadier",
  rifle: "Rifles",
  lancer: "Lancer",
  howitzer: "Howitzer",
  colorGuard: "Color Guard",
  militia: "Militiamen",
  guerrilla: "Guerillas",
  hussar: "Hussar",
  horseGun: "Horse Guns",
  engineer: "Engineer",
};
/** Lane-buy catalog drawn on the canvas (base units only). */
export const BUY_UNITS = [
  { type: "troop", label: "Troop", fill: "#2a4158", stroke: "#3d5a7a" },
  { type: "skirmisher", label: "Skirmish", fill: "#243a32", stroke: "#3a6a5a" },
  { type: "dragoon", label: "Dragoon", fill: "#322848", stroke: "#5a4a7a" },
  { type: "cannon", label: "Cannon", fill: "#3a3428", stroke: "#6a5a3a" },
  { type: "officer", label: "Officer", fill: "#3a2a28", stroke: "#7a4a3a" },
];
