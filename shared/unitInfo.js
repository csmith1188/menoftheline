import { CONFIG } from "./config.js";
import { Path } from "./path.js";
import {
  UNIT_STATS,
  VARIANT_OF_BASE,
  unitLandCost,
  unitStats,
} from "./units.js";

/** Short real-life role + tactical purpose for each spawn key. */
export const UNIT_SUMMARIES = {
  troop:
    "Line infantry — the backbone of the army. Trade fire with weight of numbers.",
  skirmisher:
    "Light infantry that fights in open order. Harass, screen, and pick at the enemy from flexible positions.",
  dragoon:
    "Mounted infantry that fire light muskets and attack with swords. Devastating when flanking their enemy.",
  cannon:
    "Field artillery that shoots a solid iron ball that bounces through files of enemies.",
  officer:
    "A Major keeps battalions together — restoring fatigue and casualties nearby.",
  grenadier:
    "Elite heavy infantry. Hold the line under pressure and shrug off pushback.",
  rifle:
    "Marksmen with rifled barrels. Accurate hunters of officers.",
  lancer:
    "Cavalry that reaches from their horse with a long spear, making them deadly in any charge.",
  howitzer:
    "Loaded with cannister shot that blasts lines of soldiers who get too close.",
  colorGuard:
    "Flag-bearers who restore the line like an Officer, and hold wounded Troops at full damage in their aura.",
  militia:
    "Cheap levied infantry. Fill the line quickly, but they break sooner and hit lighter.",
  guerrilla:
    "Civilians who take up arms and hide in terrain and open fields, ambushing and harassing enemies.",
  hussar:
    "Horsemen who counter their lack of endurance by hunting in packs.",
  horseGun:
    "Guns light enough for the crew to be carried on them, making them faster but reducing their efectiveness.",
  engineer:
    "Manages the logistics of battle, building pontoons, gathering intelligence, and passing it to friendly units.",
};

/** Base buy type for art (alternates share the base SVG). */
export function unitArtType(type) {
  return VARIANT_OF_BASE[type] || type;
}

/** In-play board type used for the geometric icon. */
export function unitIconType(type) {
  return VARIANT_OF_BASE[type] || type;
}

function fmtNum(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  if (Math.abs(value - Math.round(value)) < 1e-6) return String(Math.round(value));
  return String(Math.round(value * 10) / 10);
}

function pct(value) {
  return `${fmtNum(value * 100)}%`;
}

function times(value) {
  return `${fmtNum(value)}×`;
}

function rangePaces(stats) {
  return Math.round(Path.pacesFromPx(stats.range));
}

const BASIC_FIELDS = [
  {
    key: "hp",
    label: "HP",
    value: (s) => s.hp,
    display: (s) => fmtNum(s.hp),
  },
  {
    key: "speed",
    label: "Speed",
    value: (s) => s.speed,
    display: (s) => fmtNum(s.speed),
    invert: true,
  },
  {
    key: "chargeSpeed",
    label: "Charge",
    value: (s) => s.chargeSpeed,
    display: (s) => times(s.chargeSpeed),
  },
  {
    key: "range",
    label: "Range",
    value: (s) => s.range,
    display: (s) => `${rangePaces(s)}`,
  },
  {
    key: "rangedDamage",
    label: "Ranged",
    value: (s) => s.rangedDamage,
    display: (s) => fmtNum(s.rangedDamage),
  },
  {
    key: "meleeDamage",
    label: "Melee",
    value: (s) => s.meleeDamage,
    display: (s) => fmtNum(s.meleeDamage),
  },
  {
    key: "shootingPushback",
    label: "Shot Push",
    value: (s) => s.shootingPushback,
    display: (s) => fmtNum(s.shootingPushback),
  },
  {
    key: "meleePushback",
    label: "Melee Push",
    value: (s) => s.meleePushback,
    display: (s) => fmtNum(s.meleePushback),
  },
  {
    key: "rangedCooldown",
    label: "Reload",
    value: (s) => s.rangedCooldown,
    display: (s) => `${fmtNum(s.rangedCooldown)}s`,
    invert: true,
  },
  {
    key: "meleeCooldown",
    label: "Melee Speed",
    value: (s) => s.meleeCooldown,
    display: (s) => `${fmtNum(s.meleeCooldown)}s`,
    invert: true,
  },
];

function maxForField(field) {
  let max = 0;
  for (const key of Object.keys(UNIT_STATS)) {
    const v = field.value(UNIT_STATS[key]);
    if (typeof v === "number" && v > max) max = v;
  }
  return max > 0 ? max : 1;
}

function minForField(field) {
  let min = Infinity;
  for (const key of Object.keys(UNIT_STATS)) {
    const v = field.value(UNIT_STATS[key]);
    if (typeof v === "number" && v < min) min = v;
  }
  return Number.isFinite(min) ? min : 0;
}

function barRatio(field, value, max) {
  if (field.invert) {
    const best = minForField(field);
    return value > 0 ? Math.max(0, Math.min(1, best / value)) : 0;
  }
  return Math.max(0, Math.min(1, value / max));
}

/**
 * Gold and land prices shown beside the unit name (not as bars).
 * Land is 0 for base units.
 */
export function unitEconomy(type) {
  const stats = unitStats(type);
  const land = unitLandCost(type);
  return {
    cost: stats.cost,
    land,
    costDisplay: `${fmtNum(stats.cost)} gold`,
    landDisplay: land > 0 ? `${fmtNum(land)} land` : "",
  };
}

/**
 * Basic combat stats with bar ratios vs the roster max.
 * Inverted fields (speed, reload, melee speed) treat lower as better.
 */
export function unitBasicStats(type) {
  const stats = unitStats(type);
  return BASIC_FIELDS.map((field) => {
    const value = field.value(stats);
    const max = maxForField(field);
    return {
      key: field.key,
      label: field.label,
      value,
      display: field.display(stats),
      max,
      ratio: barRatio(field, value, max),
    };
  });
}

function splashHits(splash) {
  if (!(splash > 0)) return 1;
  return 3;
}

/**
 * Special-ability bullets for a spawn type. Numbers come from live stats/config.
 */
export function unitAbilityLines(type) {
  const stats = unitStats(type);
  const lines = [];
  const base = unitIconType(type);

  if (base === "troop" && CONFIG.troopLineBonus > 0) {
    lines.push(
      `Line shooting bonus: +${pct(CONFIG.troopLineBonus)} per other eligible troop in the line, scaled by how Perfect you are with adjacent-row neighbors (not vs Skirmishers/Rifles).`,
    );
    lines.push(
      "Advancing troops coming into line will inherit the halt/reform order of exisitng lines.",
    );
  }
  if (type === "grenadier") {
    lines.push("Takes half pushback from shooting and melee.");
  }
  if ((stats.meleePushback || 0) > 1) {
    lines.push(`Charge melee pushback: ${fmtNum(stats.meleePushback)}.`);
  }
  if ((stats.shootingPushback || 0) > 1) {
    lines.push(`Shooting pushback: ${fmtNum(stats.shootingPushback)}.`);
  }
  if (base === "skirmisher") {
    lines.push("Full reload whenever firing is allowed, including Fall Back.");
    lines.push("Troop line bonus does not apply when shooting this unit.");
    lines.push(
      "Shoots by priority: cavalry if closest, then Skirmishers/Rifles, Officers, artillery, other cavalry, then Troops.",
    );
  }
  if ((stats.officerDamageMultiplier || 1) > 1) {
    lines.push(`Deals ${times(stats.officerDamageMultiplier)} damage to Officers.`);
  }
  if (type === "dragoon" && (stats.flankMultiplier || 1) > 1.2) {
    lines.push(`Flank bonus while charging and flanking: ${times(stats.flankMultiplier)}.`);
  }
  if (type === "lancer" && (stats.chargeMultiplier || 1) > 1.2) {
    lines.push(`Charge hit bonus: ${times(stats.chargeMultiplier)} (normal flank otherwise).`);
  }
  if (base === "cannon" && type !== "howitzer" && stats.splash > 0) {
    const hits = splashHits(stats.splash);
    lines.push(
      `Shell penetrates along the row: up to ${hits} bodies (full / half / quarter damage).`,
    );
  }
  if (base === "cannon") {
    lines.push(
      `Firing recoils this gun by its shooting pushback (${fmtNum(stats.shootingPushback)}).`,
    );
  }
  if (type === "howitzer") {
    lines.push("Fires one shell at a target in every in-range row of its lane (no penetration).");
  }
  if (base === "officer" && (stats.restoreRange > 0 || stats.restoreRate > 0)) {
    const paces = CONFIG.officerRestorePaces;
    const rate = stats.restoreRate || 1;
    lines.push(
      `Restores fatigue and health to friends within range; doubled when ahead.`,
    );
    if (type === "colorGuard") {
      lines.push("Friends in this aura ignore damage loss from missing health. Does not stack with another Color Guard.");
    } else {
      lines.push("Doesn't stack with other officers.");
    }
  }
  if (type === "militia") {
    lines.push("Takes more pushback.");
  }
  if (type === "guerrilla") {
    lines.push(
      `Hidden from the enemy unless within ${fmtNum(CONFIG.guerrillaStealthPaces)} paces, in melee, or for ${fmtNum(CONFIG.guerrillaShotRevealSec)}s after shooting.`,
    );
    lines.push("Woods hide Guerillas unless occupied. Not slowed by terrain.");
    lines.push("Do not volley while Halted in the open except at enemies within stealth range; occupying a terrain feature lets them Halt-shoot at full range.");
    lines.push("Hides in plain site when not shooting or near an enemy.");
  }
  if (type === "hussar") {
    lines.push("Not slowed by terrain; still cannot enter peaks.");
    if (CONFIG.cavalryPackBonus > 0) {
      lines.push(
        `Pack bonus: +${pct(CONFIG.cavalryPackBonus)} melee damage per other friendly Hussar in melee reach.`,
      );
    }
  }
  if (type === "horseGun") {
    lines.push("Faster / lighter than Field Guns and Howitzers.");
  }
  if (type === "engineer") {
    const paces = CONFIG.officerRestorePaces;
    lines.push("Does not restore fatigue or health.");
    lines.push(
      `Within Officer range: unblocks LOS through terrain even without standing on it; rivers become pontoon bridges.`,
    );
    lines.push("Guns stranded when a pontoon drops peel back toward their own keep.");
    lines.push("While this unit occupies a hill, friends in aura gain that hill's shooting-range bonus.");
    lines.push(
      `On a hill or peak, Officer-range aura is ×${CONFIG.engineerElevationAuraFactor}.`,
    );
  }
  if (base === "officer") {
    lines.push("Most units avoid shooting Officers while another unit type is in range.");
  }

  // Charge / flank that are above the shared SHOT defaults, for types not covered above.
  if (type !== "lancer" && type !== "dragoon") {
    if ((stats.chargeMultiplier || 1) > 1.2) {
      lines.push(`Charge hit bonus: ${times(stats.chargeMultiplier)}.`);
    }
    if ((stats.flankMultiplier || 1) > 1.2) {
      lines.push(`Flank bonus: ${times(stats.flankMultiplier)}.`);
    }
  }

  return lines;
}
