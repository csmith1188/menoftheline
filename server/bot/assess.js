import { CONFIG } from "../../shared/config.js";
import { Path } from "../../shared/path.js";
import { UNIT_STATS, unitStats } from "../../shared/units.js";

const LANES = ["top", "bottom"];
const BASE_TYPES = ["troop", "skirmisher", "dragoon", "cannon", "officer"];

/** Gold price of the body on the field, including alternates. */
export function goldCost(unit) {
  return unitStats(unit.variant || unit.type).cost;
}

/** Keep-gun reach in paces, then the wider band used for threat. */
export function keepThreatReach() {
  return Path.pacesFromPx(CONFIG.capitalCannonRange) * CONFIG.botKeepThreatReachScale;
}

/**
 * Along-lane paces between two bodies. Cross-lane pairs are not local.
 * Uses the sim's station ruler so the bottom arc matches shooting.
 */
export function alongPaces(a, b) {
  if (!a || !b || a.lane !== b.lane) return Infinity;
  if (typeof a.shotPaces === "function") return a.shotPaces(b);
  return Math.abs(a.progress - b.progress) * Path.lanePaces(a.lane);
}

/** True when `other` is further toward the enemy keep than `unit`. */
export function isAhead(unit, other) {
  if (!unit || !other || unit.lane !== other.lane) return false;
  if (typeof unit.alongSigned === "function") return unit.alongSigned(other) > 1;
  return other.progress > unit.progress;
}

function clamp01(n) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Cheap combat presence. Simple is gold times remaining HP.
 * Hard also fades fatigue and, inside contact, weights the role.
 */
export function combatValue(unit, profile, band) {
  if (!unit || unit.hp <= 0) return 0;
  const hp = unit.maxHp > 0 ? Math.max(0, unit.hp) / unit.maxHp : 0;
  let fatigueFactor = 1;
  if (profile && profile.useFatigue) {
    const fat = unit.maxFatigue > 0 ? unit.fatigue / unit.maxFatigue : 0;
    fatigueFactor = 1 - CONFIG.botFatigueWeight * fat;
  }
  const brokenFactor = unit.broken ? CONFIG.botBrokenFactor : 1;
  let role = 1;
  if (profile && profile.useRole && band === "contact") {
    const key = unit.variant || unit.type;
    role = CONFIG.botRoleContact[key] != null ? CONFIG.botRoleContact[key] : 1;
  }
  return goldCost(unit) * hp * fatigueFactor * brokenFactor * role;
}

function living(side, lane) {
  const out = [];
  const troops = side && side.troops ? side.troops : [];
  for (let i = 0; i < troops.length; i += 1) {
    const unit = troops[i];
    if (unit.hp > 0 && unit.lane === lane) out.push(unit);
  }
  return out;
}

/** Sum of combat value with no distance falloff. */
export function armyStrength(units, profile) {
  let total = 0;
  for (let i = 0; i < units.length; i += 1) {
    total += combatValue(units[i], profile, "support");
  }
  return total;
}

/**
 * Distance-weighted strength of `units` around `origin`.
 * `origin` itself counts fully when it is in the list.
 */
export function localStrength(units, origin, radius, profile, band) {
  if (!(radius > 0)) return 0;
  let total = 0;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit.hp <= 0) continue;
    const dist = unit === origin ? 0 : alongPaces(origin, unit);
    if (dist > radius) continue;
    const relevance = clamp01(1 - dist / radius);
    total += combatValue(unit, profile, band) * relevance;
  }
  return total;
}

/**
 * Proximity-weighted enemy value inside the keep-threat band.
 * A body on the rim contributes almost nothing.
 */
export function laneKeepThreat(enemies, sideId, profile) {
  const reach = keepThreatReach();
  if (!(reach > 0)) return 0;
  let total = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const unit = enemies[i];
    if (unit.hp <= 0) continue;
    const paces = unit.pacesFromKeep(sideId);
    if (paces > reach) continue;
    const proximity = clamp01(1 - paces / reach);
    total += combatValue(unit, profile, "support") * proximity;
  }
  return total;
}

function sideShare(sim, side, lane) {
  const center = sim.laneCenterT(lane);
  return side.id === "player" ? center : 1 - center;
}

function frontProgress(units) {
  let best = null;
  let bestP = -1;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit.type !== "troop" && unit.type !== "skirmisher") continue;
    if (unit.progress > bestP) {
      bestP = unit.progress;
      best = unit;
    }
  }
  return best;
}

/**
 * One think of battlefield facts. Posture is applied by the controller
 * so hysteresis can remember the previous lane state.
 */
export function assessBattlefield(sim, sideId, profile) {
  const self = sim.side(sideId);
  const foe = sim.side(sideId === "player" ? "enemy" : "player");
  const hpFrac = self.capitalHP / CONFIG.capitalHP;
  const lanes = {};
  for (let i = 0; i < LANES.length; i += 1) {
    const lane = LANES[i];
    const friendlies = living(self, lane);
    const enemies = living(foe, lane);
    const friendValue = armyStrength(friendlies, profile);
    const enemyValue = armyStrength(enemies, profile);
    let advantage = friendValue / Math.max(enemyValue, 1);
    if (friendValue < 1 && enemyValue < 1) advantage = 1;
    const threat = laneKeepThreat(enemies, sideId, profile);
    lanes[lane] = {
      lane,
      friendlies,
      enemies,
      friendValue,
      enemyValue,
      advantage,
      share: sideShare(sim, self, lane),
      threat,
      front: frontProgress(friendlies),
      troopFront: null,
    };
    let troopFront = null;
    for (let f = 0; f < friendlies.length; f += 1) {
      const unit = friendlies[f];
      if (unit.type !== "troop") continue;
      if (!troopFront || unit.progress > troopFront.progress) troopFront = unit;
    }
    lanes[lane].troopFront = troopFront;
  }
  return {
    self,
    foe,
    sideId,
    hpFrac,
    keepDesperate: hpFrac < CONFIG.botDesperateKeepHp,
    lanes,
  };
}

/**
 * Next posture given the previous one. Empty threat and an even
 * ratio stay on Hold. Defend and Attack each have a stricter exit.
 */
export function nextPosture(current, stats) {
  const advantage = stats.advantage;
  const share = stats.share;
  const threat = stats.threat;
  const threatHigh = threat >= CONFIG.botKeepThreatDefend;
  const threatClear = threat < CONFIG.botKeepThreatClear;
  const wantDefend = threatHigh || advantage < CONFIG.botDefendEnterRatio;
  const wantAttack = threatClear
    && advantage > CONFIG.botAttackEnterRatio
    && share > CONFIG.botAttackShare;

  if (current === "defend") {
    if (!threatClear || advantage <= CONFIG.botDefendExitRatio) return "defend";
    return wantAttack ? "attack" : "hold";
  }
  if (current === "attack") {
    if (threatHigh || advantage < CONFIG.botAttackExitRatio) {
      return wantDefend ? "defend" : "hold";
    }
    return "attack";
  }
  if (wantDefend) return "defend";
  if (wantAttack) return "attack";
  return "hold";
}

function bandSum(units, origin, radius, profile, band, pred) {
  if (!(radius > 0)) return 0;
  let total = 0;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit === origin || unit.hp <= 0) continue;
    if (pred && !pred(unit)) continue;
    const dist = alongPaces(origin, unit);
    if (dist > radius) continue;
    const relevance = clamp01(1 - dist / radius);
    total += combatValue(unit, profile, band) * relevance;
  }
  return total;
}

/**
 * What is happening near one unit. Scans that lane's snapshot only.
 */
export function localSituation(unit, laneSnap, profile) {
  const friendlies = laneSnap ? laneSnap.friendlies : [];
  const enemies = laneSnap ? laneSnap.enemies : [];
  const contact = CONFIG.botContactPaces;
  const support = CONFIG.botSupportPaces;
  const contactFriendly = localStrength(friendlies, unit, contact, profile, "contact");
  const contactEnemy = localStrength(enemies, unit, contact, profile, "contact");
  const supportFriendly = localStrength(friendlies, unit, support, profile, "support");
  const supportEnemy = localStrength(enemies, unit, support, profile, "support");
  let nearestEnemyPaces = null;
  for (let i = 0; i < enemies.length; i += 1) {
    const dist = alongPaces(unit, enemies[i]);
    if (nearestEnemyPaces == null || dist < nearestEnemyPaces) nearestEnemyPaces = dist;
  }
  let infantryAhead = false;
  let infantryBehind = false;
  let infantrySupport = false;
  for (let i = 0; i < friendlies.length; i += 1) {
    const ally = friendlies[i];
    if (ally === unit) continue;
    if (ally.type !== "troop" && ally.type !== "skirmisher") continue;
    if (isAhead(unit, ally)) infantryAhead = true;
    else infantryBehind = true;
    if (alongPaces(unit, ally) <= support) infantrySupport = true;
  }
  const troopFront = laneSnap ? laneSnap.troopFront : null;
  return {
    contactFriendly,
    contactEnemy,
    supportFriendly,
    supportEnemy,
    supportRatio: supportFriendly / Math.max(supportEnemy, 1),
    nearestEnemyPaces,
    enemyTroopContact: bandSum(enemies, unit, contact, profile, "support", (u) => u.type === "troop"),
    enemyCavalryContact: bandSum(enemies, unit, contact, profile, "support", (u) => u.type === "dragoon"),
    infantryAhead,
    infantryBehind,
    infantrySupport,
    troopFront,
    aheadOfInfantry: Boolean(troopFront && isAhead(troopFront, unit)),
  };
}

/** Value of `type` already fielded, counting alternates at their real cost. */
export function typeGold(units) {
  const by = {};
  for (let i = 0; i < BASE_TYPES.length; i += 1) by[BASE_TYPES[i]] = 0;
  let total = 0;
  let troops = 0;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (!unit || unit.hp <= 0) continue;
    const cost = goldCost(unit);
    if (by[unit.type] != null) by[unit.type] += cost;
    total += cost;
    if (unit.type === "troop") troops += 1;
  }
  return { by, total, troops };
}

export function enemyShares(units) {
  const tally = typeGold(units);
  const total = Math.max(tally.total, 1);
  return {
    total: tally.total,
    cavalry: tally.by.dragoon / total,
    troop: tally.by.troop / total,
    support: (tally.by.cannon + tally.by.officer) / total,
    troops: tally.troops,
  };
}

/** Rows that contain a living enemy in this lane. */
export function enemyRowCount(enemies) {
  const rows = {};
  let n = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const unit = enemies[i];
    if (unit.hp <= 0) continue;
    if (rows[unit.sublane]) continue;
    rows[unit.sublane] = true;
    n += 1;
  }
  return n;
}

export { LANES, BASE_TYPES, UNIT_STATS };
