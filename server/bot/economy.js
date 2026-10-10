import { CONFIG } from "../../shared/config.js";
import {
  UNIT_STATS,
  UNIT_VARIANTS,
  isSpecialistVariety,
  unitLandCost,
  categoryOf,
  resolveUnitId,
} from "../../shared/units.js";
import { featuresOnMap } from "../../shared/terrain.js";
import {
  BASE_TYPES,
  LANES,
  enemyRowCount,
  enemyShares,
  typeGold,
} from "./assess.js";

function lanesOf(snapshot) {
  return snapshot.laneIds || LANES;
}

function townLaneOf(snapshot) {
  return snapshot.townLaneId || "bottom";
}

/**
 * Desired gold fractions. Hard shifts them toward the enemy's army,
 * then caps and renormalizes so one survivor cannot demand a whole
 * counter-army.
 */
function cappedShare(share, weight) {
  return Math.min(CONFIG.botCounterCap, Math.max(0, share) * weight);
}

const CATEGORY_SPAWN = {
  infantry: "regulars",
  skirmishers: "light",
  cavalry: "dragoon",
  artillery: "fieldGun",
  officer: "major",
};

export function desiredComposition(profile, friendUnits, enemyUnits) {
  const desired = {
    infantry: CONFIG.botComposition.infantry,
    skirmishers: CONFIG.botComposition.skirmishers,
    cavalry: CONFIG.botComposition.cavalry,
    artillery: CONFIG.botComposition.artillery,
    officer: CONFIG.botComposition.officer,
  };
  const enemy = enemyShares(enemyUnits);
  const friends = typeGold(friendUnits);
  const early = friends.total < CONFIG.botCannonArmyValue;
  const mods = {
    skirmisherFromCavalry: false,
    dragoonFromSupport: false,
    cannonFromInfantry: false,
    officerFromLine: false,
  };

  if (early) {
    const freed = desired.artillery;
    desired.artillery = 0;
    desired.skirmishers += freed * CONFIG.botEarlyCannonToSkirmisher;
    desired.cavalry += freed * (1 - CONFIG.botEarlyCannonToSkirmisher);
  }

  if (profile.dynamicComposition && enemy.total > 0) {
    const cav = cappedShare(enemy.cavalry, CONFIG.botCounterCavalry);
    const inf = early ? 0 : cappedShare(enemy.troop, CONFIG.botCounterInfantry);
    const sup = cappedShare(enemy.support, CONFIG.botCounterSupport);
    desired.skirmishers += cav;
    desired.artillery += inf;
    desired.cavalry += sup;
    if (friends.troops >= CONFIG.botOfficerLineCount) {
      desired.officer += Math.min(CONFIG.botCounterCap, CONFIG.botCounterOfficer);
      mods.officerFromLine = true;
    }
    mods.skirmisherFromCavalry = cav > 0;
    mods.cannonFromInfantry = inf > 0;
    mods.dragoonFromSupport = sup > 0 && enemy.troop < CONFIG.botTroopWallShare;
  } else if (!early && enemy.total > 0 && enemy.troop >= CONFIG.botSimpleCannonTroopShare) {
    desired.artillery += CONFIG.botSimpleCannonBump;
    mods.cannonFromInfantry = true;
  }

  let sum = 0;
  for (let i = 0; i < BASE_TYPES.length; i += 1) sum += desired[BASE_TYPES[i]];
  if (sum <= 0) sum = 1;
  for (let i = 0; i < BASE_TYPES.length; i += 1) desired[BASE_TYPES[i]] /= sum;
  return { desired, mods, friends };
}

function deficitList(desired, friends) {
  const total = friends.total;
  const list = [];
  for (let i = 0; i < BASE_TYPES.length; i += 1) {
    const type = BASE_TYPES[i];
    const have = total > 0 ? friends.by[type] / total : 0;
    const deficit = desired[type] - have;
    if (deficit > 0.001) list.push({ type, deficit });
  }
  list.sort((a, b) => b.deficit - a.deficit);
  return list;
}

function landLeft(side, spawnKey) {
  return side.land - unitLandCost(spawnKey);
}

function upgradeReserve(side) {
  const kinds = ["armor", "speed", "damage"];
  let best = Infinity;
  for (let i = 0; i < kinds.length; i += 1) {
    if (side.upgrades[kinds[i]] >= CONFIG.upgradeMax) continue;
    best = Math.min(best, side.upgradeCost(kinds[i]));
  }
  return best === Infinity ? 0 : best;
}

function countType(units, typeOrCategory) {
  const cat = BASE_TYPES.includes(typeOrCategory)
    ? typeOrCategory
    : categoryOf(resolveUnitId(typeOrCategory));
  let n = 0;
  for (let i = 0; i < units.length; i += 1) {
    if (units[i].hp > 0 && categoryOf(units[i]) === cat) n += 1;
  }
  return n;
}

function mapKinds(mapId) {
  const features = featuresOnMap(mapId);
  const kinds = { woodsOrPeaks: false, riverOrHill: false };
  for (let i = 0; i < features.length; i += 1) {
    const kind = features[i].kind;
    if (kind === "woods" || kind === "peak") kinds.woodsOrPeaks = true;
    if (kind === "river" || kind === "hill") kinds.riverOrHill = true;
  }
  return kinds;
}

/** Land that must remain after an alternate buy (full upgrade for elites). */
function altLandReserve(side, key) {
  const reserve = upgradeReserve(side);
  if (isSpecialistVariety(key)) {
    return Math.floor(reserve * CONFIG.botLightAltLandReserve);
  }
  return reserve;
}

function canBuyAlt(side, key) {
  if (!key || !side.canAffordUnit(key)) return false;
  const reserve = altLandReserve(side, key);
  if (unitLandCost(key) > 0 && landLeft(side, key) < reserve) return false;
  return true;
}

/**
 * Alternate spawn key when the profile allows it and the land cost does
 * not eat the next upgrade reserve. Otherwise the base unit.
 * UNIT_VARIANTS lists yellow (elite) then white (light).
 */
export function chooseSpawnKey(side, base, profile, ctx) {
  if (!profile.alternates) return base;
  const alts = UNIT_VARIANTS[base] || [];
  const yellow = alts[0];
  const white = alts[1];
  const laneUnits = ctx.laneUnits;
  const mods = ctx.mods;

  if (yellow && canBuyAlt(side, yellow)) {
    if (base === "regulars"
      && countType(laneUnits, "infantry") >= CONFIG.botMinTroopsBeforeSupport
      && ctx.posture !== "hold"
      && ctx.posture !== "defend") {
      return yellow;
    }
    if (base === "light" && ctx.mapHasWoodsOrPeaks) return yellow;
    if (base === "dragoon" && ctx.frontSlowed) return yellow;
    if (base === "fieldGun"
      && (ctx.enemyRows >= CONFIG.botHowitzerMinRows || ctx.gunsBlocked)) {
      return yellow;
    }
    if (base === "major" && ctx.mapHasRiverOrHill) return yellow;
  }

  if (!white || !canBuyAlt(side, white)) return base;
  // Cheap light filler when the base unit is out of reach.
  if (!side.canAffordUnit(base)) return white;
  if (base === "regulars") {
    if (countType(laneUnits, "infantry") < CONFIG.botMinTroopsBeforeSupport) return base;
    if (ctx.posture !== "hold" && ctx.posture !== "defend") return base;
    return white;
  }
  if (base === "light") {
    if (!mods.skirmisherFromCavalry) return base;
    if (countType(ctx.allFriends, "skirmishers") < 1) return base;
    return white;
  }
  if (base === "dragoon") {
    if (!mods.dragoonFromSupport) return base;
    return white;
  }
  if (base === "fieldGun") {
    if (ctx.enemyRows < CONFIG.botHowitzerMinRows) return base;
    return white;
  }
  if (base === "major") {
    if (countType(ctx.allFriends, "officer") < 1) return base;
    if (ctx.armyValue < CONFIG.botColorGuardMinValue) return base;
    return white;
  }
  return base;
}

/** How freely the lane front can march (1 = clear, lower = slowed by terrain). */
function laneFrontMoveFactor(info) {
  const front = info.troopFront;
  if (!front) return 1;
  if (typeof front.terrainMoveFactor === "function") return front.terrainMoveFactor();
  return 1;
}

function urgencyOf(snapshot, lane, profile) {
  const info = snapshot.lanes[lane];
  const threat = info.threat * CONFIG.botUrgencyThreat;
  const disadvantage = (Math.max(0, info.enemyValue - info.friendValue) / UNIT_STATS.regulars.cost)
    * CONFIG.botUrgencyDisadvantage;
  const shareDeficit = Math.max(0, 0.5 - info.share) * CONFIG.botUrgencyShare;
  let economy = 0;
  const townLane = townLaneOf(snapshot);
  if (lane === townLane && bottomSeedOpen(snapshot)) {
    economy = CONFIG.botUrgencyEconomy * (profile.richUrgency ? 1 : 0.65);
  }
  let garrison = 0;
  if (lane === "top" && snapshot.lanes.top && snapshot.lanes.top.friendlies.length < CONFIG.botTopGarrison) {
    garrison = CONFIG.botTopGarrisonUrgency;
  }
  let opportunity = 0;
  if (profile.richUrgency) {
    if (info.commit === "keepAttack") opportunity += CONFIG.botUrgencyOpportunity;
    if (lane === townLane && info.advantage > 1.1 && snapshot.townsOpen > 0) {
      opportunity += CONFIG.botUrgencyOpportunity * 0.5;
    }
  }
  // Slow terrain at the front makes opportunistic pushes less urgent.
  const move = laneFrontMoveFactor(info);
  if (move < 0.95) opportunity *= Math.max(0.5, move);
  return threat + disadvantage + shareDeficit + economy + garrison + opportunity;
}

/** A town-lane seed waits until the top lane can actually defend the keep. */
function bottomSeedOpen(snapshot) {
  if (snapshot.townsOwned > 0) return false;
  const top = snapshot.lanes.top;
  const town = snapshot.lanes[townLaneOf(snapshot)];
  if (!top || top.friendlies.length < CONFIG.botTopGarrison) return false;
  if (!town) return false;
  return town.friendlies.length < CONFIG.botBottomSeed;
}

/** Buy lane. Sticky so a one-point swing does not bounce purchases. */
export function pickBuyLane(snapshot, state, profile) {
  const laneIds = lanesOf(snapshot);
  let best = state.buyLane || laneIds[0] || "top";
  let bestScore = -Infinity;
  let rawBest = laneIds[0] || "top";
  let rawScore = -Infinity;
  for (let i = 0; i < laneIds.length; i += 1) {
    const lane = laneIds[i];
    if (!snapshot.lanes[lane]) continue;
    const score = urgencyOf(snapshot, lane, profile);
    if (score > rawScore) {
      rawScore = score;
      rawBest = lane;
    }
    const sticky = state.buyLane === lane ? CONFIG.botLaneStickiness : 0;
    if (score + sticky > bestScore) {
      bestScore = score + sticky;
      best = lane;
    }
  }
  if (!state.buyLane) best = rawBest;
  state.buyLane = best;
  state.buyScore = bestScore;
  return best;
}

function laneTroopCount(units) {
  return countType(units, "infantry");
}

function canBank(side, sim) {
  return side.banks < CONFIG.bankCount
    && side.bankUnlockedByTime(side.banks)
    && side.gold >= side.bankCost();
}

function taxPressure(side) {
  return side.income <= side.massTax() + CONFIG.botTaxMargin;
}

function armyValue(snapshot) {
  return snapshot.lanes.top.friendValue + snapshot.lanes.bottom.friendValue;
}

function foeArmyValue(snapshot) {
  return snapshot.lanes.top.enemyValue + snapshot.lanes.bottom.enemyValue;
}

/**
 * One gold or land action. Combat deficits are filled before banks,
 * except when upkeep already eats income.
 */
export function decideEconomy(bot, sim, snapshot, profile) {
  const self = snapshot.self;
  const lane = pickBuyLane(snapshot, bot, profile);
  const info = snapshot.lanes[lane];
  const desperate = info.desperate || snapshot.keepDesperate;
  const allFriends = snapshot.lanes.top.friendlies.concat(snapshot.lanes.bottom.friendlies);
  const allEnemies = snapshot.lanes.top.enemies.concat(snapshot.lanes.bottom.enemies);
  const composed = desiredComposition(profile, allFriends, allEnemies);
  const deficits = deficitList(composed.desired, composed.friends);
  const topDeficit = deficits.length ? deficits[0].deficit : 0;

  if (!desperate && taxPressure(self) && canBank(self, sim)) {
    sim.applyCommand(bot.sideId, { type: "bank" });
    return;
  }

  if (desperate) {
    const bought = tryBuy(bot, sim, self, lane, "infantry", profile, composed, info, allFriends);
    if (bought) return;
    if (taxPressure(self) && canBank(self, sim)) {
      sim.applyCommand(bot.sideId, { type: "bank" });
    }
    return;
  }

  if (laneTroopCount(info.friendlies) < CONFIG.botMinTroopsBeforeSupport) {
    if (tryBuy(bot, sim, self, lane, "infantry", profile, composed, info, allFriends)) return;
  }

  const deficitLarge = topDeficit > CONFIG.botUpgradeDeficitSkip;
  if (profile.hard && deficitLarge) {
    if (buyAffordableDeficit(bot, sim, self, lane, profile, composed, info, allFriends, deficits)) {
      return;
    }
  }

  if (!(profile.hard && deficitLarge) && tryUpgrade(bot, sim, snapshot, self, profile, info)) return;

  if (buyAffordableDeficit(bot, sim, self, lane, profile, composed, info, allFriends, deficits)) {
    return;
  }

  const ahead = armyValue(snapshot) >= foeArmyValue(snapshot);
  const postureOk = info.posture !== "defend";
  if (profile.hard && ahead && postureOk && canBank(self, sim)
    && self.gold >= self.bankCost() + CONFIG.botBankReserve) {
    sim.applyCommand(bot.sideId, { type: "bank" });
    return;
  }
  if (ahead && canBank(self, sim)) {
    sim.applyCommand(bot.sideId, { type: "bank" });
  }
}

function buyAffordableDeficit(bot, sim, self, lane, profile, composed, info, allFriends, deficits) {
  for (let i = 0; i < deficits.length; i += 1) {
    if (tryBuy(bot, sim, self, lane, deficits[i].type, profile, composed, info, allFriends)) {
      return true;
    }
  }
  return false;
}

function tryBuy(bot, sim, self, lane, category, profile, composed, info, allFriends) {
  const base = CATEGORY_SPAWN[category] || category;
  const kinds = mapKinds(sim.mapId);
  const key = chooseSpawnKey(self, base, profile, {
    laneUnits: info.friendlies,
    allFriends,
    mods: composed.mods,
    posture: info.posture,
    enemyRows: enemyRowCount(info.enemies),
    armyValue: composed.friends.total,
    mapHasWoodsOrPeaks: kinds.woodsOrPeaks,
    mapHasRiverOrHill: kinds.riverOrHill,
    frontSlowed: laneFrontMoveFactor(info) < 0.95,
    gunsBlocked: kinds.woodsOrPeaks || kinds.riverOrHill,
  });
  if (!self.canAffordUnit(key)) {
    if (key !== base && self.canAffordUnit(base)) {
      return sim.applyCommand(bot.sideId, { type: "buy", lane, unit: base });
    }
    return false;
  }
  return sim.applyCommand(bot.sideId, { type: "buy", lane, unit: key });
}

function upgradeTown(snapshot, self, mode, posture) {
  const towns = snapshot.towns;
  if (mode === "hard" && posture) {
    let kind = "damage";
    if (posture === "defend") kind = "armor";
    else if (snapshot.bottomFar) kind = "speed";
    for (let i = 0; i < towns.length; i += 1) {
      const town = towns[i];
      if (town.owner !== self.id || town.producing) continue;
      if (self.upgrades[town.upgradeKind()] >= CONFIG.upgradeMax) continue;
      if (town.upgradeKind() === kind && self.land >= self.upgradeCost(kind)) return town;
    }
  }
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < towns.length; i += 1) {
    const town = towns[i];
    if (town.owner !== self.id || town.producing) continue;
    const kind = town.upgradeKind();
    if (self.upgrades[kind] >= CONFIG.upgradeMax) continue;
    if (self.land < self.upgradeCost(kind)) continue;
    const dx = town.x - self.keep.x;
    const dy = town.y - self.keep.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = town;
    }
  }
  return best;
}

function tryUpgrade(bot, sim, snapshot, self, profile, info) {
  if (snapshot.keepDesperate || info.desperate) return false;
  const town = upgradeTown(snapshot, self, profile.hard ? "hard" : "simple", info.posture);
  if (!town) return false;
  return sim.applyCommand(bot.sideId, { type: "townProduce", checkpointId: town.index });
}

export function attachEconomyFacts(sim, snapshot) {
  let owned = 0;
  let open = 0;
  const towns = sim.checkpoints;
  for (let i = 0; i < towns.length; i += 1) {
    if (towns[i].owner === snapshot.self.id) owned += 1;
    else open += 1;
  }
  snapshot.townsOwned = owned;
  snapshot.townsOpen = open;
  snapshot.towns = towns;
  const front = snapshot.lanes.bottom.troopFront;
  snapshot.bottomFar = !front || front.progress < 0.35;
}
