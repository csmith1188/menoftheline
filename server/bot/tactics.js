import { CONFIG } from "../../shared/config.js";
import { Path } from "../../shared/path.js";
import { combatValue, isAhead, localSituation, alongPaces } from "./assess.js";
import { formationFix } from "./formations.js";

function vitality(unit) {
  const hp = unit.maxHp > 0 ? Math.max(0, unit.hp) / unit.maxHp : 0;
  const fat = unit.maxFatigue > 0 ? unit.fatigue / unit.maxFatigue : 0;
  return hp - fat;
}

function memoryOf(bot, unit) {
  return bot.unitMemory.get(unit.id) || null;
}

function paceGap(behind, ahead) {
  return (ahead.progress - behind.progress) * Path.lanePaces(behind.lane);
}

/** Friendly and enemy value sitting within support range of the enemy keep. */
function valueNearEnemyKeep(info, foeId, profile) {
  const radius = CONFIG.botSupportPaces;
  let friendly = 0;
  let enemy = 0;
  for (let i = 0; i < info.friendlies.length; i += 1) {
    const unit = info.friendlies[i];
    if (unit.pacesFromKeep(foeId) <= radius) friendly += combatValue(unit, profile, "support");
  }
  for (let i = 0; i < info.enemies.length; i += 1) {
    const unit = info.enemies[i];
    if (unit.pacesFromKeep(foeId) <= radius) enemy += combatValue(unit, profile, "support");
  }
  return { friendly, enemy, ratio: friendly / Math.max(enemy, 1) };
}

export function nextCommit(prev, info, profile, foeId) {
  if (info.posture !== "attack") return null;
  if (profile.keepCommitLocal) {
    const near = valueNearEnemyKeep(info, foeId, profile);
    if (prev === "keepAttack") {
      if (near.ratio < CONFIG.botKeepAbortRatio) return null;
      return "keepAttack";
    }
    if (near.friendly >= CONFIG.botKeepCommitValue && near.ratio >= CONFIG.botKeepCommitRatio) {
      return "keepAttack";
    }
    return null;
  }
  const front = info.troopFront;
  if (prev === "keepAttack") {
    if (info.advantage < CONFIG.botKeepAbortRatio) return null;
    return "keepAttack";
  }
  if (front && front.progress >= CONFIG.botKeepCommitProgress
    && info.advantage >= CONFIG.botKeepCommitRatio) {
    return "keepAttack";
  }
  return null;
}

function troopIntent(unit, local, info, profile, mem) {
  const ratio = local.supportRatio;
  const enemies = local.supportEnemy > 1;
  const retreatAt = info.desperate ? CONFIG.botRetreatRatioDesperate : CONFIG.botRetreatRatio;
  const retreating = mem
    && (mem.intent === "fallback" || mem.intent === "retreat")
    && mem.reason !== "vitality";
  const range = unit.rangePaces();
  const inRange = local.nearestEnemyPaces != null && local.nearestEnemyPaces <= range;

  if (info.commit === "keepAttack") return { intent: "advance", reason: "keep" };
  if (retreating) {
    if (ratio >= CONFIG.botResumeRatio) {
      return inRange
        ? { intent: "halt", reason: "range" }
        : { intent: "advance", reason: "march" };
    }
    return { intent: "fallback", reason: "ratio" };
  }
  if (enemies && ratio < retreatAt) return { intent: "fallback", reason: "ratio" };
  if (info.posture === "defend" && enemies && ratio < CONFIG.botResumeRatio) {
    return { intent: "halt", reason: "defend" };
  }
  if (profile.hard
    && info.posture === "attack"
    && local.nearestEnemyPaces != null
    && local.nearestEnemyPaces <= CONFIG.botContactPaces
    && ratio >= CONFIG.botInfantryChargeRatio) {
    return { intent: "charge", reason: "charge" };
  }
  if (inRange) return { intent: "halt", reason: "range" };
  return { intent: "advance", reason: "march" };
}

function applyVitality(decision, unit, mem) {
  const hurt = vitality(unit) < CONFIG.botSurvivalVitality;
  const clearing = mem && mem.reason === "vitality" && vitality(unit) < CONFIG.botSurvivalClear;
  if (hurt || clearing) {
    decision.intent = "fallback";
    decision.reason = "vitality";
    decision.solo = true;
  }
  return decision;
}

function harmonize(decisions, profile) {
  if (!profile.groupRetreat) return;
  const seen = new Set();
  for (let i = 0; i < decisions.length; i += 1) {
    const seed = decisions[i];
    if (seen.has(seed.unit.id)) continue;
    const bodies = [];
    for (let d = 0; d < decisions.length; d += 1) bodies.push(decisions[d].unit);
    const line = seed.unit.lineGroup(bodies);
    const members = [];
    for (let g = 0; g < line.length; g += 1) {
      seen.add(line[g].id);
      for (let d = 0; d < decisions.length; d += 1) {
        if (decisions[d].unit === line[g]) members.push(decisions[d]);
      }
    }
    if (members.length < 2) continue;
    let falling = false;
    for (let m = 0; m < members.length; m += 1) {
      if (members[m].intent === "fallback" && members[m].reason === "ratio") falling = true;
    }
    if (!falling) continue;
    for (let m = 0; m < members.length; m += 1) {
      members[m].intent = "fallback";
      if (members[m].reason !== "vitality") members[m].reason = "ratio";
      members[m].solo = false;
      members[m].formation = null;
    }
  }
}

function screenBlocked(unit, troopDecisions) {
  for (let i = 0; i < troopDecisions.length; i += 1) {
    const troop = troopDecisions[i];
    if (troop.intent !== "advance") continue;
    if (troop.unit.lane !== unit.lane || troop.unit.sublane !== unit.sublane) continue;
    if (!isAhead(troop.unit, unit)) continue;
    const gap = paceGap(troop.unit, unit);
    if (gap < CONFIG.botContactPaces * 0.5) return true;
  }
  return false;
}

function skirmisherIntent(unit, local, info, mem, troopDecisions) {
  const self = combatValue(unit, { useFatigue: false, useRole: false }, "support");
  const threatened = local.enemyTroopContact > self || local.enemyCavalryContact > 0;
  if (threatened || screenBlocked(unit, troopDecisions)) {
    return { intent: "fallback", reason: "threat" };
  }
  if (mem && mem.intent === "fallback" && mem.reason === "threat" && mem.threatClearSince == null) {
    return { intent: "fallback", reason: "threat", armClear: true };
  }
  const front = info.troopFront;
  if (!front) return { intent: "advance", reason: "screen" };
  const gap = (unit.progress - front.progress) * Path.lanePaces(unit.lane);
  if (gap < CONFIG.botSkirmishOffset - CONFIG.botSkirmishBand) {
    return { intent: "advance", reason: "screen" };
  }
  if (gap > CONFIG.botSkirmishOffset + CONFIG.botSkirmishBand) {
    return { intent: "fallback", reason: "screen" };
  }
  return { intent: "halt", reason: "screen" };
}

function bestChargeScore(unit, enemies, local) {
  const support = CONFIG.botSupportPaces;
  const blob = local.enemyTroopContact > local.supportFriendly;
  let best = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const foe = enemies[i];
    const dist = alongPaces(unit, foe);
    if (dist > support) continue;
    let score = 0;
    if (foe.type === "cannon" || foe.type === "officer") score += CONFIG.botChargeSupportBonus;
    if (foe.maxHp > 0 && foe.hp / foe.maxHp < 0.5) score += CONFIG.botChargeWeakBonus;
    if (foe.order === "fallback" || foe.order === "retreat") score += CONFIG.botChargeRetreatBonus;
    let supported = false;
    for (let j = 0; j < enemies.length; j += 1) {
      const other = enemies[j];
      if (other === foe || other.type !== "troop") continue;
      if (alongPaces(foe, other) <= support) supported = true;
    }
    if (!supported) score += CONFIG.botChargeIsolatedBonus;
    if (blob) score -= CONFIG.botChargeBlobPenalty;
    score *= Math.max(0, 1 - dist / support);
    if (score > best) best = score;
  }
  return best;
}

function cavalryIntent(unit, local, info, profile, mem) {
  const charging = mem && mem.intent === "charge";
  if (profile.chargeScoring && local.infantrySupport) {
    const score = bestChargeScore(unit, info.enemies, local);
    if (charging && score >= CONFIG.botChargeAbort) return { intent: "charge", reason: "charge" };
    if (!charging && score >= CONFIG.botChargeScore) return { intent: "charge", reason: "charge" };
  } else if (!profile.chargeScoring && local.infantrySupport && local.nearestEnemyPaces != null) {
    const engage = unit.rangePaces() * (unit.engageRange == null ? 0.5 : unit.engageRange);
    if (local.nearestEnemyPaces <= engage) return { intent: "charge", reason: "charge" };
  }
  if (local.infantryAhead) return { intent: "advance", reason: "leash" };
  let hasInfantry = false;
  for (let i = 0; i < info.friendlies.length; i += 1) {
    const ally = info.friendlies[i];
    if (ally !== unit && (ally.type === "troop" || ally.type === "skirmisher")) hasInfantry = true;
  }
  if (!hasInfantry) return { intent: "fallback", reason: "leash" };
  if (!local.infantrySupport && local.infantryBehind) return { intent: "fallback", reason: "leash" };
  return { intent: "halt", reason: "leash" };
}

function cannonIntent(unit, local, mem) {
  const range = unit.rangePaces();
  const nearest = local.nearestEnemyPaces;
  const inner = range * CONFIG.botCannonHaltBand;
  const outer = range * CONFIG.botCannonAdvanceBand;
  const clear = CONFIG.botContactPaces * CONFIG.botCannonFallbackClear;
  if (local.aheadOfInfantry) return { intent: "fallback", reason: "gun" };
  if (nearest != null && nearest <= CONFIG.botContactPaces) return { intent: "fallback", reason: "gun" };
  if (mem && mem.intent === "fallback" && mem.reason === "gun") {
    if (nearest != null && nearest < clear) return { intent: "fallback", reason: "gun" };
  }
  if (mem && mem.intent === "halt" && mem.reason === "gun") {
    if (nearest == null || nearest > outer) return { intent: "advance", reason: "gun" };
    return { intent: "halt", reason: "gun" };
  }
  if (nearest != null && nearest <= inner) return { intent: "halt", reason: "gun" };
  return { intent: "advance", reason: "gun" };
}

function officerIntent(unit, local, info, mem) {
  const contact = local.enemyCavalryContact > 0
    || (local.nearestEnemyPaces != null && local.nearestEnemyPaces <= CONFIG.botContactPaces);
  if (contact) return { intent: "fallback", reason: "threat" };
  if (mem && mem.intent === "fallback" && mem.reason === "threat") {
    if (local.nearestEnemyPaces != null && local.nearestEnemyPaces < CONFIG.botSupportPaces) {
      return { intent: "fallback", reason: "threat" };
    }
  }
  const front = info.troopFront;
  if (!front) return { intent: "fallback", reason: "support" };
  const gap = (front.progress - unit.progress) * Path.lanePaces(unit.lane);
  if (gap < -5) return { intent: "fallback", reason: "support" };
  if (gap > CONFIG.officerRestorePaces) return { intent: "advance", reason: "support" };
  return { intent: "halt", reason: "support" };
}

function blank(unit, intent, reason) {
  return {
    unit,
    intent,
    reason,
    solo: false,
    formation: null,
    armClear: false,
  };
}

/**
 * One intent per living unit. Troop lines are harmonized before
 * formation geometry is allowed to replace a move.
 */
export function decideIntents(bot, snapshot, profile) {
  const out = [];
  const lanes = ["top", "bottom"];
  for (let L = 0; L < lanes.length; L += 1) {
    const info = snapshot.lanes[lanes[L]];
    const troopDecisions = [];
    for (let i = 0; i < info.friendlies.length; i += 1) {
      const unit = info.friendlies[i];
      if (unit.broken || unit.type !== "troop") continue;
      const local = localSituation(unit, info, profile);
      const mem = memoryOf(bot, unit);
      const decision = blank(unit, "advance", "march");
      const next = troopIntent(unit, local, info, profile, mem);
      decision.intent = next.intent;
      decision.reason = next.reason;
      applyVitality(decision, unit, mem);
      troopDecisions.push(decision);
    }
    harmonize(troopDecisions, profile);
    for (let i = 0; i < troopDecisions.length; i += 1) {
      const decision = troopDecisions[i];
      const melee = decision.unit.isInMelee(snapshot.foe.troops);
      if (!melee && (decision.intent === "advance" || decision.intent === "halt") && !decision.solo) {
        const fix = formationFix(decision.unit, info.friendlies);
        if (fix === "wait" || (fix && fix.action)) decision.formation = fix;
        if (fix && fix.catchIn != null) decision.catchIn = fix.catchIn;
      }
      out.push(decision);
    }
    for (let i = 0; i < info.friendlies.length; i += 1) {
      const unit = info.friendlies[i];
      if (unit.broken || unit.type === "troop") continue;
      const local = localSituation(unit, info, profile);
      const mem = memoryOf(bot, unit);
      let decision;
      if (unit.type === "skirmisher") {
        const next = skirmisherIntent(unit, local, info, mem, troopDecisions);
        decision = blank(unit, next.intent, next.reason);
        decision.armClear = Boolean(next.armClear);
        decision.solo = true;
      } else if (unit.type === "dragoon") {
        const next = cavalryIntent(unit, local, info, profile, mem);
        decision = blank(unit, next.intent, next.reason);
        decision.solo = true;
      } else if (unit.type === "cannon") {
        const next = cannonIntent(unit, local, mem);
        decision = blank(unit, next.intent, next.reason);
        decision.solo = true;
      } else if (unit.type === "officer") {
        const next = officerIntent(unit, local, info, mem);
        decision = blank(unit, next.intent, next.reason);
        decision.solo = true;
      } else {
        continue;
      }
      applyVitality(decision, unit, mem);
      out.push(decision);
    }
  }
  return out;
}

export function rememberIntents(bot, sim, decisions) {
  for (let i = 0; i < decisions.length; i += 1) {
    const decision = decisions[i];
    const prev = bot.unitMemory.get(decision.unit.id) || {};
    const next = {
      intent: decision.intent,
      reason: decision.reason,
      since: sim.elapsed,
      threatClearSince: prev.threatClearSince || null,
    };
    if (decision.armClear) {
      if (next.threatClearSince == null) next.threatClearSince = sim.elapsed;
    } else if (decision.reason === "threat") {
      next.threatClearSince = null;
    } else {
      next.threatClearSince = null;
    }
    bot.unitMemory.set(decision.unit.id, next);
  }
}
