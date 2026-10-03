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
const SHOT = {
  shootingPushback: 1,
  meleePushback: 1,
  pushbackTakenFactor: 1,
  chargeMultiplier: 1.2,
  projectileSize: 4,
  projectileSpeed: 220,
  projectileColor: "#f3d27a",
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
    cost: 100,
    lineBonus: 0.2,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
  },
  skirmisher: {
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
    lineBonus: 0,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    shootingPushback: 2,
  },
  dragoon: {
    ...SHOT,
    hp: 200,
    rangedDamage: 15,
    meleeDamage: 20,
    range: 200,
    engageRange: 0.5,
    chargeSpeed: 1.5,
    flankMultiplier: 1.8,
    rangedCooldown: 1.5,
    meleeCooldown: 1.5,
    speed: 25,
    cost: 200,
    lineBonus: 0,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
  },
  cannon: {
    ...SHOT,
    hp: 100,
    rangedDamage: 120,
    meleeDamage: 10,
    range: 300,
    engageRange: 0.5,
    chargeSpeed: 1.2,
    flankMultiplier: 1.2,
    rangedCooldown: 6,
    meleeCooldown: 6,
    speed: 12,
    cost: 300,
    lineBonus: 0,
    fightsMelee: true,
    splash: 0.5,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
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
    cost: 200,
    lineBonus: 0,
    fightsMelee: true,
    splash: 0,
    restoreRange: 100,
    restoreRate: 2,
    restoreHealth: true,
    officerDamageMultiplier: 1,
  },
  // Alternates (same base type in play; white square behind the icon)
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
    cost: 150,
    lineBonus: 0.2,
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
    rangedDamage: 20,
    meleeDamage: 10,
    range: 220,
    engageRange: 1,
    chargeSpeed: 1.5,
    flankMultiplier: 1.2,
    rangedCooldown: 1.5,
    meleeCooldown: 2,
    speed: 15,
    cost: 200,
    lineBonus: 0,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 2,
    shootingPushback: 1
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
    cost: 250,
    lineBonus: 0,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
    meleePushback: 2,
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
    cost: 400,
    lineBonus: 0,
    fightsMelee: true,
    splash: 0,
    restoreRange: 0,
    restoreRate: 0,
    officerDamageMultiplier: 1,
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
    cost: 400,
    lineBonus: 0,
    fightsMelee: true,
    splash: 0,
    restoreRange: 100,
    restoreRate: 2,
    restoreHealth: true,
    officerDamageMultiplier: 1,
  },
};
export function unitStats(type) {
  return UNIT_STATS[type] || UNIT_STATS.troop;
}

/** True when `type` is an alternate spawn key (grenadier, rifle, …). */
export function isAlternateUnit(type) {
  return Boolean(VARIANT_OF_BASE[type]);
}

/**
 * Land price to buy an alternate. Bases cost 0 land.
 * Defaults to unitLandCostRatio of the gold cost unless stats.landCost is set.
 */
export function unitLandCost(type) {
  if (!isAlternateUnit(type)) return 0;
  const stats = unitStats(type);
  if (stats.landCost != null) return stats.landCost;
  return Math.round(stats.cost * CONFIG.unitLandCostRatio);
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

/** Base buy type → alternate spawn key. */
export const UNIT_VARIANTS = {
  troop: "grenadier",
  skirmisher: "rifle",
  dragoon: "lancer",
  cannon: "howitzer",
  officer: "colorGuard",
};
/** Alternate spawn key → base buy type. */
export const VARIANT_OF_BASE = Object.fromEntries(
  Object.entries(UNIT_VARIANTS).map(([base, variant]) => [variant, base]),
);
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
};
/** Lane-buy catalog drawn on the canvas (base units only). */
export const BUY_UNITS = [
  { type: "troop", label: "Troop", fill: "#2a4158", stroke: "#3d5a7a" },
  { type: "skirmisher", label: "Skirmish", fill: "#243a32", stroke: "#3a6a5a" },
  { type: "dragoon", label: "Dragoon", fill: "#322848", stroke: "#5a4a7a" },
  { type: "cannon", label: "Cannon", fill: "#3a3428", stroke: "#6a5a3a" },
  { type: "officer", label: "Officer", fill: "#3a2a28", stroke: "#7a4a3a" },
];
