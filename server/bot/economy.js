import { CONFIG } from "../../shared/config.js";
import { UNIT_STATS, UNIT_VARIANTS, unitLandCost } from "../../shared/units.js";
import { BASE_TYPES, LANES, enemyRowCount, enemyShares, typeGold } from "./assess.js";

/**
 * Desired gold fractions. Hard shifts them toward the enemy's army,
 * then caps and renormalizes so one survivor cannot demand a whole
 * counter-army.
 */
function cappedShare(share, weight) {
  return Math.min(CONFIG.botCounterCap, Math.max(0, share) * weight);
}

export function desiredComposition(profile, friendUnits, enemyUnits) {
  const desired = {
    troop: CONFIG.botComposition.troop,
    skirmisher: CONFIG.botComposition.skirmisher,
    dragoon: CONFIG.botComposition.dragoon,
    cannon: CONFIG.botComposition.cannon,
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
    const freed = desired.cannon;
    desired.cannon = 0;
    desired.skirmisher += freed * CONFIG.botEarlyCannonToSkirmisher;
    desired.dragoon += freed * (1 - CONFIG.botEarlyCannonToSkirmisher);
  }

  if (profile.dynamicComposition && enemy.total > 0) {
    const cav = cappedShare(enemy.cavalry, CONFIG.botCounterCavalry);
    const inf = early ? 0 : cappedShare(enemy.troop, CONFIG.botCounterInfantry);
    const sup = cappedShare(enemy.support, CONFIG.botCounterSupport);
    desired.skirmisher += cav;
    desired.cannon += inf;
    desired.dragoon += sup;
    if (friends.troops >= CONFIG.botOfficerLineCount) {
      desired.officer += Math.min(CONFIG.botCounterCap, CONFIG.botCounterOfficer);
      mods.officerFromLine = true;
    }
    mods.skirmisherFromCavalry = cav > 0;
    mods.cannonFromInfantry = inf > 0;
    mods.dragoonFromSupport = sup > 0 && enemy.troop < CONFIG.botTroopWallShare;
  } else if (!early && enemy.total > 0 && enemy.troop >= CONFIG.botSimpleCannonTroopShare) {
    desired.cannon += CONFIG.botSimpleCannonBump;
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

function countType(units, type) {
  let n = 0;
  for (let i = 0; i < units.length; i += 1) {
    if (units[i].hp > 0 && units[i].type === type) n += 1;
  }
  return n;
}

/**
 * Alternate spawn key when Hard still wants that role and the land
 * cost does not eat the next upgrade. Otherwise the base unit.
 */
export function chooseSpawnKey(side, base, profile, ctx) {
  if (!profile.alternates) return base;
  const alt = UNIT_VARIANTS[base];
  if (!alt || !side.canAffordUnit(alt)) return base;
  const reserve = upgradeReserve(side);
  if (landLeft(side, alt) < reserve) return base;
  const laneUnits = ctx.laneUnits;
  const mods = ctx.mods;
  if (base === "troop") {
    if (countType(laneUnits, "troop") < CONFIG.botMinTroopsBeforeSupport) return base;
    if (ctx.posture !== "hold" && ctx.posture !== "defend") return base;
    return alt;
  }
  if (base === "skirmisher") {
    if (!mods.skirmisherFromCavalry) return base;
    if (countType(ctx.allFriends, "skirmisher") < 1) return base;
    return alt;
  }
  if (base === "dragoon") {
    if (!mods.dragoonFromSupport) return base;
    return alt;
  }
  if (base === "cannon") {
    if (ctx.enemyRows < CONFIG.botHowitzerMinRows) return base;
    return alt;
  }
  if (base === "officer") {
    if (countType(ctx.allFriends, "officer") < 1) return base;
    if (ctx.armyValue < CONFIG.botColorGuardMinValue) return base;
    return alt;
  }
  return base;
}

function urgencyOf(snapshot, lane, profile) {
  const info = snapshot.lanes[lane];
  const threat = info.threat * CONFIG.botUrgencyThreat;
  const disadvantage = (Math.max(0, info.enemyValue - info.friendValue) / UNIT_STATS.troop.cost)
    * CONFIG.botUrgencyDisadvantage;
  const shareDeficit = Math.max(0, 0.5 - info.share) * CONFIG.botUrgencyShare;
  let economy = 0;
  if (lane === "bottom" && bottomSeedOpen(snapshot)) {
    economy = CONFIG.botUrgencyEconomy * (profile.richUrgency ? 1 : 0.65);
  }
  let garrison = 0;
  if (lane === "top" && snapshot.lanes.top.friendlies.length < CONFIG.botTopGarrison) {
    garrison = CONFIG.botTopGarrisonUrgency;
  }
  let opportunity = 0;
  if (profile.richUrgency) {
    if (info.commit === "keepAttack") opportunity += CONFIG.botUrgencyOpportunity;
    if (lane === "bottom" && info.advantage > 1.1 && snapshot.townsOpen > 0) {
      opportunity += CONFIG.botUrgencyOpportunity * 0.5;
    }
  }
  return threat + disadvantage + shareDeficit + economy + garrison + opportunity;
}

/** A bottom seed waits until the top lane can actually defend the keep. */
function bottomSeedOpen(snapshot) {
  if (snapshot.townsOwned > 0) return false;
  if (snapshot.lanes.top.friendlies.length < CONFIG.botTopGarrison) return false;
  return snapshot.lanes.bottom.friendlies.length < CONFIG.botBottomSeed;
}

/** Buy lane. Sticky so a one-point swing does not bounce purchases. */
export function pickBuyLane(snapshot, state, profile) {
  let best = state.buyLane || "top";
  let bestScore = -Infinity;
  let rawBest = "top";
  let rawScore = -Infinity;
  for (let i = 0; i < LANES.length; i += 1) {
    const lane = LANES[i];
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
  return countType(units, "troop");
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
    const bought = tryBuy(bot, sim, self, lane, "troop", profile, composed, info, allFriends);
    if (bought) return;
    if (taxPressure(self) && canBank(self, sim)) {
      sim.applyCommand(bot.sideId, { type: "bank" });
    }
    return;
  }

  if (laneTroopCount(info.friendlies) < CONFIG.botMinTroopsBeforeSupport) {
    if (tryBuy(bot, sim, self, lane, "troop", profile, composed, info, allFriends)) return;
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

function tryBuy(bot, sim, self, lane, base, profile, composed, info, allFriends) {
  const key = chooseSpawnKey(self, base, profile, {
    laneUnits: info.friendlies,
    allFriends,
    mods: composed.mods,
    posture: info.posture,
    enemyRows: enemyRowCount(info.enemies),
    armyValue: composed.friends.total,
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
    const dx = town.x - self.capital.x;
    const dy = town.y - self.capital.y;
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
