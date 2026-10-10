import { CONFIG } from "./config.js";

/**
 * Canonical unit catalog. Each spawn key is a distinct unit identity with an
 * explicit category, variety, and mobility class.
 *
 * Categories: infantry | skirmishers | cavalry | artillery | officer
 * Varieties:  standard | specialist | elite
 * Mobility:   foot | mounted | limbered  (terrain only; independent of category)
 *
 * Living units carry category (line/targeting family), unit (spawn id), and
 * variety. Legacy type/variant/alternate are dual-emitted for one release.
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

export const UNIT_CATEGORIES = [
  "infantry",
  "skirmishers",
  "cavalry",
  "artillery",
  "officer",
];

export const UNIT_VARIETIES = ["standard", "specialist", "elite"];

export const MOBILITY_CLASSES = ["foot", "mounted", "limbered"];

/** Old spawn key → canonical unit id (buy / summary / snapshot compat). */
export const UNIT_ALIASES = {
  troop: "regulars",
  skirmisher: "light",
  cannon: "fieldGun",
  officer: "major",
};

/** Canonical unit id → preferred legacy spawn key (dual-emit). */
export const UNIT_LEGACY_IDS = {
  regulars: "troop",
  light: "skirmisher",
  fieldGun: "cannon",
  major: "officer",
};

/** Old mobility string → canonical mobility class. */
export const MOBILITY_ALIASES = {
  infantry: "foot",
  cavalry: "mounted",
  artillery: "limbered",
  cannon: "limbered",
};

/** Category → old in-play base type (dual-emit `type` field). */
export const CATEGORY_LEGACY_TYPE = {
  infantry: "troop",
  skirmishers: "skirmisher",
  cavalry: "dragoon",
  artillery: "cannon",
  officer: "officer",
};

/** Old in-play base type → category. */
export const LEGACY_TYPE_CATEGORY = {
  troop: "infantry",
  skirmisher: "skirmishers",
  dragoon: "cavalry",
  cannon: "artillery",
  officer: "officer",
  // New keys also accepted as legacy type during transition
  regulars: "infantry",
  light: "skirmishers",
  fieldGun: "artillery",
  major: "officer",
};

/** Regulars musket balls (and infantry variants). */
const PROJECTILE_COLOR_TROOP = "#f3d27a";
/** Non-regulars small arms (light, dragoon, major, …). */
const PROJECTILE_COLOR_OTHER = "#fff3b0";
/** Field gun / howitzer / horse gun / keep shells. */
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

/**
 * Per-unit taxonomy + combat stats. Keys are canonical spawn ids.
 * Stats fields match the former UNIT_STATS shape.
 */
export const UNITS = {
  regulars: {
    category: "infantry",
    variety: "standard",
    mobility: "foot",
    label: "Regulars",
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
  militia: {
    category: "infantry",
    variety: "specialist",
    mobility: "foot",
    label: "Militia",
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
  grenadier: {
    category: "infantry",
    variety: "elite",
    mobility: "foot",
    label: "Grenadiers",
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
  light: {
    category: "skirmishers",
    variety: "standard",
    mobility: "foot",
    label: "Light",
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
  guerrilla: {
    category: "skirmishers",
    variety: "specialist",
    mobility: "foot",
    label: "Guerrillas",
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
  rifle: {
    category: "skirmishers",
    variety: "elite",
    mobility: "foot",
    label: "Rifles",
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
  dragoon: {
    category: "cavalry",
    variety: "standard",
    mobility: "mounted",
    label: "Dragoons",
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
  hussar: {
    category: "cavalry",
    variety: "specialist",
    mobility: "mounted",
    label: "Hussars",
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
  lancer: {
    category: "cavalry",
    variety: "elite",
    mobility: "mounted",
    label: "Lancers",
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
  fieldGun: {
    category: "artillery",
    variety: "standard",
    mobility: "limbered",
    label: "Field Guns",
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
  horseGun: {
    category: "artillery",
    variety: "specialist",
    mobility: "limbered",
    label: "Horse Guns",
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
  howitzer: {
    category: "artillery",
    variety: "elite",
    mobility: "limbered",
    label: "Howitzers",
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
  major: {
    category: "officer",
    variety: "standard",
    mobility: "foot",
    label: "Major",
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
  engineer: {
    category: "officer",
    variety: "specialist",
    mobility: "foot",
    label: "Engineer",
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
  colorGuard: {
    category: "officer",
    variety: "elite",
    mobility: "foot",
    label: "Color Guard",
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
};

/** Stats-only view of UNITS (compat with former UNIT_STATS consumers). */
export const UNIT_STATS = {};
for (const [id, def] of Object.entries(UNITS)) {
  const { category, variety, mobility, label, ...stats } = def;
  UNIT_STATS[id] = stats;
}
// Legacy spawn-key aliases into UNIT_STATS
for (const [legacy, canonical] of Object.entries(UNIT_ALIASES)) {
  UNIT_STATS[legacy] = UNIT_STATS[canonical];
}

/**
 * Category → variety slots. Swipe order is standard → elite → specialist
 * (preserves former base → yellow → white UX).
 */
export const CATEGORY_UNITS = {
  infantry: { standard: "regulars", elite: "grenadier", specialist: "militia" },
  skirmishers: { standard: "light", elite: "rifle", specialist: "guerrilla" },
  cavalry: { standard: "dragoon", elite: "lancer", specialist: "hussar" },
  artillery: { standard: "fieldGun", elite: "howitzer", specialist: "horseGun" },
  officer: { standard: "major", elite: "colorGuard", specialist: "engineer" },
};

/** Resolve any known id (canonical, legacy spawn, or category standard) to unit id. */
export function resolveUnitId(type) {
  if (!type) return "regulars";
  if (UNITS[type]) return type;
  if (UNIT_ALIASES[type]) return UNIT_ALIASES[type];
  return "regulars";
}

/** Full unit definition (taxonomy + stats). */
export function unitDef(type) {
  return UNITS[resolveUnitId(type)] || UNITS.regulars;
}

export function unitStats(type) {
  return UNIT_STATS[resolveUnitId(type)] || UNIT_STATS.regulars;
}

export function unitCategory(type) {
  return unitDef(type).category;
}

export function unitVariety(type) {
  return unitDef(type).variety;
}

export function unitLabel(type) {
  return unitDef(type).label;
}

/** Mobility class for terrain rules (river/peak/etc.). */
export function mobilityClass(type) {
  const id = resolveUnitId(type);
  if (UNITS[id]) return UNITS[id].mobility;
  const aliased = MOBILITY_ALIASES[type];
  return aliased || "foot";
}

/** Normalize a mobility string (accepts legacy infantry/cavalry/artillery). */
export function resolveMobility(mob) {
  if (!mob) return "foot";
  if (MOBILITY_CLASSES.includes(mob)) return mob;
  return MOBILITY_ALIASES[mob] || "foot";
}

/** Category for a living unit or type/variant pair. */
export function categoryOf(unitOrType, variant) {
  if (unitOrType && typeof unitOrType === "object") {
    if (unitOrType.category) return unitOrType.category;
    const id = unitOrType.unit || unitOrType.variant || unitOrType.type;
    if (id && UNITS[resolveUnitId(id)]) return unitCategory(id);
    if (unitOrType.type && LEGACY_TYPE_CATEGORY[unitOrType.type]) {
      return LEGACY_TYPE_CATEGORY[unitOrType.type];
    }
    return "infantry";
  }
  if (variant) return unitCategory(variant);
  if (LEGACY_TYPE_CATEGORY[unitOrType]) return LEGACY_TYPE_CATEGORY[unitOrType];
  return unitCategory(unitOrType);
}

/** Spawn unit id for a living unit snapshot or type/variant. */
export function unitIdOf(unitOrType, variant) {
  if (unitOrType && typeof unitOrType === "object") {
    if (unitOrType.unit) return resolveUnitId(unitOrType.unit);
    if (unitOrType.variant) return resolveUnitId(unitOrType.variant);
    if (unitOrType.type) return resolveUnitId(unitOrType.type);
    return "regulars";
  }
  if (variant) return resolveUnitId(variant);
  return resolveUnitId(unitOrType);
}

/** Standard unit id for a category. */
export function standardOf(category) {
  const slot = CATEGORY_UNITS[category];
  return slot ? slot.standard : "regulars";
}

/**
 * Base buy type → elite then specialist alternate spawn keys.
 * Keys are both category and standard unit id for lookup convenience.
 */
export const UNIT_VARIANTS = {};
for (const [cat, slot] of Object.entries(CATEGORY_UNITS)) {
  UNIT_VARIANTS[cat] = [slot.elite, slot.specialist];
  UNIT_VARIANTS[slot.standard] = [slot.elite, slot.specialist];
  const legacy = CATEGORY_LEGACY_TYPE[cat];
  if (legacy && legacy !== slot.standard) {
    UNIT_VARIANTS[legacy] = [slot.elite, slot.specialist];
  }
}

/** Alternate / any non-standard spawn key → category standard (buy base). */
export const VARIANT_OF_BASE = {};
for (const slot of Object.values(CATEGORY_UNITS)) {
  VARIANT_OF_BASE[slot.elite] = slot.standard;
  VARIANT_OF_BASE[slot.specialist] = slot.standard;
}

/** Buy-base (standard unit id or legacy base) for a spawn key. */
export function buyBaseOf(type) {
  const id = resolveUnitId(type);
  const def = UNITS[id];
  if (!def) return "regulars";
  return CATEGORY_UNITS[def.category].standard;
}

/** Spawn keys shown on a buy button: standard, elite, specialist. */
export function variantOptions(base) {
  const id = resolveUnitId(base);
  const cat = unitCategory(id);
  const slot = CATEGORY_UNITS[cat];
  if (!slot) return [id];
  return [slot.standard, slot.elite, slot.specialist];
}

/** Next spawn key when swiping a buy button. dir is -1 left or +1 right. */
export function cycleVariantPick(base, current, dir) {
  const options = variantOptions(base);
  const cur = resolveUnitId(current);
  let idx = options.indexOf(cur);
  if (idx < 0) idx = 0;
  const n = options.length;
  const step = dir < 0 ? -1 : 1;
  return options[(idx + step + n) % n];
}

/** True when `type` is not the standard variety of its category. */
export function isAlternateUnit(type) {
  return unitVariety(type) !== "standard";
}

/** True when `type` is the specialist (white badge) variety. */
export function isSpecialistVariety(type) {
  return unitVariety(type) === "specialist";
}

/** @deprecated Use isSpecialistVariety */
export function isLightAlternate(type) {
  return isSpecialistVariety(type);
}

/** True when `type` is the elite (yellow badge) variety. */
export function isEliteVariety(type) {
  return unitVariety(type) === "elite";
}

/** Badge fill behind a non-standard silhouette, or null for standards. */
export function variantBadgeFill(type) {
  const variety = unitVariety(type);
  if (variety === "specialist") return CONFIG.colors.whiteAlternate;
  if (variety === "elite") return CONFIG.colors.yellowAlternate;
  return null;
}

/**
 * Land price to buy a non-standard unit. Standards cost 0 land.
 * Specialist uses specialistUnitLandCostRatio (alias lightUnitLandCostRatio);
 * elite uses unitLandCostRatio. stats.landCost overrides either ratio.
 */
export function unitLandCost(type) {
  if (!isAlternateUnit(type)) return 0;
  const stats = unitStats(type);
  if (stats.landCost != null) return stats.landCost;
  const specialistRatio =
    CONFIG.specialistUnitLandCostRatio ?? CONFIG.lightUnitLandCostRatio;
  const ratio = isSpecialistVariety(type)
    ? specialistRatio
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
    const stats = unitStats(unitIdOf(troop));
    tax += stats.cost * rate;
  }
  return tax;
}

/** Short labels for buy buttons and inspect text. */
export const UNIT_LABELS = {};
for (const [id, def] of Object.entries(UNITS)) {
  UNIT_LABELS[id] = def.label;
}
for (const [legacy, canonical] of Object.entries(UNIT_ALIASES)) {
  UNIT_LABELS[legacy] = UNIT_LABELS[canonical];
}

/** Lane-buy catalog drawn on the canvas (standard units / one per category). */
export const BUY_UNITS = [
  { type: "regulars", label: "Regulars", fill: "#2a4158", stroke: "#3d5a7a" },
  { type: "light", label: "Light", fill: "#243a32", stroke: "#3a6a5a" },
  { type: "dragoon", label: "Dragoons", fill: "#322848", stroke: "#5a4a7a" },
  { type: "fieldGun", label: "Field Guns", fill: "#3a3428", stroke: "#6a5a3a" },
  { type: "major", label: "Major", fill: "#3a2a28", stroke: "#7a4a3a" },
];

/** Legacy buy-base type from category (for dual-emit snapshots). */
export function legacyTypeOfCategory(category) {
  return CATEGORY_LEGACY_TYPE[category] || "troop";
}

/** Legacy variant field: null for standard, else unit id (or legacy id if any). */
export function legacyVariantOf(unitId) {
  const id = resolveUnitId(unitId);
  const def = UNITS[id];
  if (!def || def.variety === "standard") return null;
  return id;
}
