import { CONFIG } from "../shared/config.js";
import { Path } from "../shared/path.js";
import { UNIT_STATS, UNIT_VARIANTS, unitStats } from "../shared/units.js";

const LANES = ["top", "bottom"];
const TARGET_MODES = ["bastion", "attrition", "terror"];
const STRATEGY_MODES = ["auto", ...TARGET_MODES];
const DIFFICULTIES = ["simple", "hard"];
const BASE_TYPES = ["troop", "skirmisher", "dragoon", "officer", "cannon"];
/** Unit kinds that form adjacent-row battle lines. */
const LINE_TYPES = ["troop", "skirmisher"];

/** This side's fraction of a lane. Empty lanes stay at one half. */
function sideShare(sim, side, lane) {
  const center = sim.laneCenterT(lane);
  return side.id === "player" ? center : 1 - center;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function vitality(troop) {
  const hpPct = troop.maxHp > 0 ? Math.max(0, troop.hp) / troop.maxHp : 0;
  const fatPct = troop.maxFatigue > 0 ? troop.fatigue / troop.maxFatigue : 0;
  return hpPct - fatPct;
}

function livingInLane(side, lane) {
  const out = [];
  for (let i = 0; i < side.troops.length; i += 1) {
    const t = side.troops[i];
    if (t.hp > 0 && !t.broken && t.lane === lane) out.push(t);
  }
  return out;
}

function countTypes(troops) {
  const counts = {
    troop: 0,
    skirmisher: 0,
    dragoon: 0,
    officer: 0,
    cannon: 0,
  };
  for (let i = 0; i < troops.length; i += 1) {
    const type = troops[i].type;
    if (counts[type] !== undefined) counts[type] += 1;
  }
  return counts;
}

/**
 * Built-in opponent. Decides from the live sim and issues the same
 * commands a human seat would, so the core step never special-cases bots.
 *
 * Order algorithm (first match wins, per unit):
 *  1. Row hygiene — unstack same-row mates; step loners toward partners.
 *  2. Form — lone unit with a same-type partner behind on an adjacent row
 *     Reforms once; units that can walk into a line ahead Advance;
 *     already-formed lines Advance up the lane as a group (no re-dress).
 *     After Reform finishes (Halt), resume Advance on the whole line.
 *  3. Cavalry leash — no infantry near → Fallback; enemy near → Charge;
 *     infantry ahead → Advance; else Halt and wait. Never Reform to leash.
 *  4. Hard only — low vitality → Fallback; type micro (skirmisher / officer /
 *     cannon) with the same leash for dragoons.
 */
export class BotController {
  constructor(sideId, options = {}) {
    this.sideId = sideId;
    this.difficulty = DIFFICULTIES.includes(options.difficulty)
      ? options.difficulty
      : "simple";
    this.strategy = {
      top: STRATEGY_MODES.includes(options.strategy && options.strategy.top)
        ? options.strategy.top
        : "auto",
      bottom: STRATEGY_MODES.includes(options.strategy && options.strategy.bottom)
        ? options.strategy.bottom
        : "auto",
    };
    this.locks = new Map();
  }

  setDifficulty(difficulty) {
    if (DIFFICULTIES.includes(difficulty)) this.difficulty = difficulty;
  }

  setLaneStrategy(lane, mode) {
    if (lane !== "top" && lane !== "bottom") return;
    if (!STRATEGY_MODES.includes(mode)) return;
    this.strategy[lane] = mode;
  }

  act(sim) {
    if (sim.winner) return;
    const self = sim.side(this.sideId);
    const foe = sim.side(this.sideId === "player" ? "enemy" : "player");
    const desperate = this.isDesperate(self, foe);
    this.updateTargeting(sim, self);
    if (this.difficulty === "hard") {
      this.hardOrders(sim, self, foe, desperate);
    } else {
      this.simpleOrders(sim, self, foe);
    }
    this.spend(sim, self, foe, desperate);
  }

  cmd(sim, payload) {
    return sim.applyCommand(this.sideId, payload);
  }

  locked(sim, troop) {
    return sim.elapsed < (this.locks.get(troop.id) || 0);
  }

  /** Issue one order action if the lock has expired. */
  order(sim, troop, action, solo) {
    if (!troop || troop.hp <= 0 || troop.broken || this.locked(sim, troop)) {
      return false;
    }
    // Reform/restore must not be solo: solo sets ignoreLineOrders and
    // blocks tryJoinAhead / takeReformFromBehind.
    const useSolo = solo != null
      ? Boolean(solo)
      : action !== "reform" && action !== "restore";
    const ok = this.cmd(sim, {
      type: "order",
      troopId: troop.id,
      action,
      solo: useSolo,
    });
    if (ok) {
      const until = sim.elapsed + CONFIG.botOrderCooldown;
      this.locks.set(troop.id, until);
      // Group orders move the whole line — lock mates so the next unit
      // in the loop does not peel them with a conflicting command.
      if (!useSolo && troop.side) {
        const line = troop.lineGroup(troop.side.troops);
        for (let i = 0; i < line.length; i += 1) {
          this.locks.set(line[i].id, until);
        }
      }
    }
    return ok;
  }

  /** Slide one unit to an exact sublane. Only for units not already in a line. */
  switchRow(sim, troop, sublane) {
    if (!troop || troop.hp <= 0 || troop.broken || this.locked(sim, troop)) {
      return false;
    }
    if (troop.switchBlocked && troop.switchBlocked()) return false;
    const count = Path.sublaneCount(troop.lane);
    if (!Number.isInteger(sublane) || sublane < 0 || sublane >= count) return false;
    if (sublane === troop.sublane) return false;
    const ok = this.cmd(sim, {
      type: "order",
      troopId: troop.id,
      action: "lane",
      sublane,
      solo: true,
    });
    if (ok) this.locks.set(troop.id, sim.elapsed + CONFIG.botOrderCooldown);
    return ok;
  }

  /**
   * Move toward a desired speed/order using player-equivalent actions.
   * desired: null | "halt" | "charge" | "fallback" | "reform"
   *
   * Advance / Halt / Reform apply to the whole line (solo false). Charge
   * and Fallback peel one body unless solo is passed explicitly false.
   */
  desireOrder(sim, troop, desired, solo) {
    if (!troop || troop.hp <= 0 || troop.broken || this.locked(sim, troop)) {
      return false;
    }
    const current = troop.orderHeld ? troop.heldOrder : troop.order;
    const peel = solo != null ? Boolean(solo) : true;
    if (desired === "reform") {
      if (current === "reform") return false;
      return this.order(sim, troop, "reform", false);
    }
    if (current === "reform") {
      if (desired === null) return this.order(sim, troop, "restore", false);
      // Charge and fallback may interrupt reform.
      if (desired === "charge") return this.order(sim, troop, "charge", peel);
      if (desired === "fallback") return this.order(sim, troop, "fallback", peel);
      return false;
    }
    if (desired === "charge") {
      if (current === "charge") return false;
      return this.order(sim, troop, "charge", peel);
    }
    if (desired === "fallback") {
      if (current === "fallback" || current === "retreat") return false;
      return this.order(sim, troop, "fallback", peel);
    }
    if (desired === "halt") {
      if (current === "halt") return false;
      // Whole line steps together — solo peels and leaves mates marching.
      if (current === "charge" || current === null) {
        return this.order(sim, troop, "speedDown", false);
      }
      if (current === "fallback" || current === "retreat") {
        return this.order(sim, troop, "speedUp", false);
      }
      return false;
    }
    // Advance (null). speedDown from charge — never "back" (that Fallbacks).
    if (current === null) return false;
    if (current === "charge") return this.order(sim, troop, "speedDown", false);
    if (current === "halt" || current === "fallback" || current === "retreat") {
      return this.order(sim, troop, "speedUp", false);
    }
    return false;
  }

  isDesperate(self, foe) {
    const hpFrac = self.capitalHP / CONFIG.capitalHP;
    if (hpFrac < CONFIG.botDesperateKeepHp) return true;
    const range = CONFIG.capitalCannonRange;
    for (let i = 0; i < foe.troops.length; i += 1) {
      const t = foe.troops[i];
      if (t.hp > 0 && dist(t, self.capital) <= range) return true;
    }
    return false;
  }

  updateTargeting(sim, self) {
    for (let i = 0; i < LANES.length; i += 1) {
      const lane = LANES[i];
      const override = this.strategy[lane];
      let mode;
      if (override !== "auto") {
        mode = override;
      } else {
        const share = sideShare(sim, self, lane);
        if (share < CONFIG.botShareBastion) mode = "bastion";
        else if (share > CONFIG.botShareTerror) mode = "terror";
        else mode = "attrition";
      }
      if (self.targeting[lane] !== mode) {
        this.cmd(sim, { type: "targeting", lane, mode });
      }
    }
  }

  weakestLane(sim, self) {
    const top = sideShare(sim, self, "top");
    const bottom = sideShare(sim, self, "bottom");
    return bottom < top ? "bottom" : "top";
  }

  threatenedLane(sim, self, foe) {
    const range = CONFIG.capitalCannonRange * 1.5;
    let topNear = 0;
    let bottomNear = 0;
    for (let i = 0; i < foe.troops.length; i += 1) {
      const t = foe.troops[i];
      if (t.hp <= 0) continue;
      if (dist(t, self.capital) > range) continue;
      if (t.lane === "top") topNear += 1;
      else bottomNear += 1;
    }
    if (topNear === 0 && bottomNear === 0) return this.weakestLane(sim, self);
    return bottomNear > topNear ? "bottom" : "top";
  }

  spend(sim, self, foe, desperate) {
    if (desperate) {
      const lane = this.threatenedLane(sim, self, foe);
      if (this.buyPrefer(sim, self, lane, ["troop", "cannon", "skirmisher", "dragoon", "officer"])) {
        return;
      }
      return;
    }

    const tax = self.massTax();
    const canBank = self.banks < CONFIG.bankCount
      && self.bankUnlockedByTime(self.banks)
      && self.gold >= self.bankCost();
    if (canBank && self.income <= tax + 0.01) {
      this.cmd(sim, { type: "bank" });
      return;
    }

    const lane = this.weakestLane(sim, self);
    const bought = this.difficulty === "hard"
      ? this.buyHard(sim, self, foe, lane)
      : this.buySimple(sim, self, lane);
    if (bought) return;

    if (canBank && sim.laneArmyValue(self, "top") + sim.laneArmyValue(self, "bottom")
      >= sim.laneArmyValue(foe, "top") + sim.laneArmyValue(foe, "bottom")) {
      this.cmd(sim, { type: "bank" });
      return;
    }

    this.buyUpgrades(sim, self);
  }

  /** Prefer first affordable type (with Hard land-variant upgrade). */
  buyPrefer(sim, self, lane, types) {
    for (let i = 0; i < types.length; i += 1) {
      const unit = this.pickUnitKey(self, types[i]);
      if (self.canAffordUnit(unit) && this.cmd(sim, { type: "buy", lane, unit })) {
        return true;
      }
    }
    return false;
  }

  pickUnitKey(self, base) {
    if (this.difficulty !== "hard") return base;
    const alt = UNIT_VARIANTS[base];
    if (!alt) return base;
    if (self.canAffordUnit(alt)) return alt;
    return base;
  }

  buySimple(sim, self, lane) {
    const allies = livingInLane(self, lane);
    const counts = countTypes(allies);
    if (counts.troop === 0) {
      const early = this.pickUnitKey(self, "troop");
      if (self.canAffordUnit(early)) {
        return this.cmd(sim, { type: "buy", lane, unit: early });
      }
    }
    const weights = CONFIG.botSimpleRatio;
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < BASE_TYPES.length; i += 1) {
      const type = BASE_TYPES[i];
      const w = weights[type] || 0;
      if (w <= 0) continue;
      const unit = this.pickUnitKey(self, type);
      const score = w / (counts[type] + 1);
      if (score > bestScore && self.canAffordUnit(unit)) {
        bestScore = score;
        best = unit;
      }
    }
    if (!best) return false;
    return this.cmd(sim, { type: "buy", lane, unit: best });
  }

  buyHard(sim, self, foe, lane) {
    const allies = livingInLane(self, lane);
    const foes = livingInLane(foe, lane);
    const mine = countTypes(allies);
    const theirs = countTypes(foes);
    const allyN = allies.length;
    const foeVal = sim.laneArmyValue(foe, lane);

    if (mine.troop + mine.skirmisher < 2) {
      if (this.buyPrefer(sim, self, lane, ["troop"])) return true;
    }
    if (theirs.dragoon > 0 || theirs.officer > 0) {
      if (this.buyPrefer(sim, self, lane, ["skirmisher"])) return true;
    }
    if (theirs.troop >= CONFIG.botCannonCluster || foeVal > UNIT_STATS.troop.cost * 3) {
      if (mine.cannon < 2 && this.buyPrefer(sim, self, lane, ["cannon"])) return true;
    }
    if (allyN >= CONFIG.botOfficerAllyMin && mine.officer === 0) {
      if (this.buyPrefer(sim, self, lane, ["officer"])) return true;
    }
    if (mine.troop >= theirs.troop && mine.troop >= 2 && mine.dragoon < mine.troop) {
      if (this.buyPrefer(sim, self, lane, ["dragoon"])) return true;
    }
    return this.buySimple(sim, self, lane);
  }

  buyUpgrades(sim, self) {
    const towns = sim.checkpoints
      .filter((town) => town.owner === self.id && !town.producing)
      .filter((town) => self.upgrades[town.upgradeKind()] < CONFIG.upgradeMax)
      .sort((a, b) => dist(a, self.capital) - dist(b, self.capital));
    if (!towns.length) return false;
    return this.cmd(sim, {
      type: "townProduce",
      checkpointId: towns[0].index,
    });
  }

  // --- Orders: Simple ---

  simpleOrders(sim, self, foe) {
    this.formLines(sim, self, foe);
    this.leashCavalry(sim, self, foe);
  }

  /**
   * Form adjacent-row lines, then keep them Advancing up the lane.
   * Reform only to let a rear partner catch the front — never to dress
   * an already-formed line, and never instead of marching.
   * Returns ids that received a formation command this tick.
   */
  formLines(sim, self, foe) {
    const busy = new Set();
    for (let L = 0; L < LANES.length; L += 1) {
      const lane = LANES[L];
      const allies = livingInLane(self, lane);
      for (let t = 0; t < LINE_TYPES.length; t += 1) {
        this.formLinesOfType(sim, self, foe, lane, LINE_TYPES[t], allies, busy);
      }
    }
    return busy;
  }

  formLinesOfType(sim, self, foe, lane, type, allies, busy) {
    const units = [];
    for (let i = 0; i < allies.length; i += 1) {
      if (allies[i].type === type) units.push(allies[i]);
    }
    if (units.length < 2) return;

    const seenLine = new Set();

    for (let i = 0; i < units.length; i += 1) {
      const troop = units[i];
      if (busy.has(troop.id)) continue;
      if (troop.lineInMelee(allies, foe.troops)) continue;

      // Leave combat orders alone — Hard survival / charge owns those.
      if (troop.order === "charge" || troop.order === "fallback"
        || troop.order === "retreat") {
        continue;
      }

      const line = troop.lineGroup(units);
      const inLine = line.length >= 2;

      if (inLine) {
        if (seenLine.has(line[0].id)) continue;
        for (let g = 0; g < line.length; g += 1) seenLine.add(line[g].id);

        // Still dressing: wait for finishReform → Halt.
        if (line.some((u) => u.order === "reform")) {
          for (let g = 0; g < line.length; g += 1) busy.add(line[g].id);
          continue;
        }
        // After Reform (or melee leave) the line Halts — march together.
        if (line.some((u) => u.order === "halt")) {
          if (this.desireOrder(sim, line[0], null)) {
            for (let g = 0; g < line.length; g += 1) busy.add(line[g].id);
          }
          continue;
        }
        // Formed and Advancing: keep going up the lane. No sideways shift,
        // no re-Reform to dress — Advance owns fire-hold when squared.
        continue;
      }

      // --- Lone units only below ---

      const mate = troop.sameRowMate(units);
      if (mate) {
        const mateLine = mate.lineGroup(units);
        // Prefer moving the unit that is not already in a real line.
        if (mateLine.length >= 2) {
          // Mate is anchored; peel this stacker.
        } else if (troop.id > mate.id) {
          continue;
        }
        const free = this.pickFreeRowNear(troop, units);
        if (free != null && this.switchRow(sim, troop, free)) {
          busy.add(troop.id);
          continue;
        }
      }

      const nearest = this.nearestSameType(troop, units);
      if (nearest && Math.abs(nearest.sublane - troop.sublane) > 1) {
        const step = nearest.sublane > troop.sublane
          ? troop.sublane + 1
          : troop.sublane - 1;
        if (this.rowFreeFor(troop, units, step) && this.switchRow(sim, troop, step)) {
          busy.add(troop.id);
          continue;
        }
      }

      // Walk up into a line ahead — stay on Advance.
      if (troop.canJoinLineAhead(units)) {
        if (troop.order === "reform" || troop.order === "halt") {
          if (this.desireOrder(sim, troop, null)) busy.add(troop.id);
        }
        continue;
      }

      // Partner on an adjacent row behind: Reform so the rear can catch up.
      // Same-speed Advance never closes that gap.
      const behind = troop.nextBehindOtherSublane(units);
      if (behind) {
        if (troop.order === "reform") {
          busy.add(troop.id);
        } else if (this.desireOrder(sim, troop, "reform")) {
          busy.add(troop.id);
        }
        continue;
      }

      // Partner ahead on an adjacent row: march (do not Reform from the rear).
      const ahead = troop.nextAheadOtherSublane(units);
      if (ahead) {
        if (troop.order === "reform" || troop.order === "halt") {
          if (this.desireOrder(sim, troop, null)) busy.add(troop.id);
        }
      }
    }
  }

  nearestSameType(troop, units) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < units.length; i += 1) {
      const other = units[i];
      if (other === troop) continue;
      const d = dist(troop, other);
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  rowFreeFor(troop, units, sublane) {
    const count = Path.sublaneCount(troop.lane);
    if (sublane < 0 || sublane >= count) return false;
    for (let i = 0; i < units.length; i += 1) {
      if (units[i] !== troop && units[i].sublane === sublane) return false;
    }
    return true;
  }

  /** Prefer an empty adjacent row; else any empty row in the lane. */
  pickFreeRowNear(troop, units) {
    const count = Path.sublaneCount(troop.lane);
    const prefs = [troop.sublane - 1, troop.sublane + 1];
    for (let i = 0; i < prefs.length; i += 1) {
      if (this.rowFreeFor(troop, units, prefs[i])) return prefs[i];
    }
    for (let s = 0; s < count; s += 1) {
      if (s !== troop.sublane && this.rowFreeFor(troop, units, s)) return s;
    }
    return null;
  }

  /**
   * Keep cavalry with the infantry. Halt when they pull ahead — Reform
   * would finish to Halt and re-trigger forever.
   */
  leashCavalry(sim, self, foe) {
    for (let i = 0; i < self.troops.length; i += 1) {
      const troop = self.troops[i];
      if (troop.hp <= 0 || troop.broken || troop.type !== "dragoon") continue;
      this.applyCavalryLeash(sim, troop, self, foe);
    }
  }

  applyCavalryLeash(sim, troop, self, foe) {
    const range = CONFIG.dragoonSupportRange;
    const allies = livingInLane(self, troop.lane);
    const foes = livingInLane(foe, troop.lane);
    const hasInfNear = this.kindNear(troop, allies, "troop", range)
      || this.kindNear(troop, allies, "skirmisher", range);
    const hasInfAhead = this.kindAhead(troop, allies, "troop")
      || this.kindAhead(troop, allies, "skirmisher");

    if (!hasInfNear) {
      this.desireOrder(sim, troop, "fallback");
      return;
    }
    if (this.enemyInEngage(troop, foes) || this.enemyNear(troop, foes, range)) {
      this.desireOrder(sim, troop, "charge");
      return;
    }
    if (hasInfAhead) {
      this.desireOrder(sim, troop, null);
      return;
    }
    // Infantry is beside or behind: wait; do not Reform.
    this.desireOrder(sim, troop, "halt");
  }

  // --- Orders: Hard ---

  hardOrders(sim, self, foe, desperate) {
    const busy = this.formLines(sim, self, foe);
    for (let i = 0; i < self.troops.length; i += 1) {
      const troop = self.troops[i];
      if (troop.hp <= 0 || troop.broken) continue;
      if (busy.has(troop.id)) continue;

      if (!desperate && vitality(troop) < CONFIG.botSurvivalVitality) {
        this.desireOrder(sim, troop, "fallback");
        continue;
      }
      // Hysteresis: only resume once clearly recovered, so vitality
      // jitter around the threshold does not flip Fallback ↔ Advance.
      if (!desperate && troop.order === "fallback"
        && vitality(troop) >= CONFIG.botSurvivalVitality + 0.15) {
        this.desireOrder(sim, troop, null);
        continue;
      }

      if (troop.type === "skirmisher") this.microSkirmisher(sim, troop, self, foe);
      else if (troop.type === "officer") this.microOfficer(sim, troop, self, foe);
      else if (troop.type === "dragoon") this.applyCavalryLeash(sim, troop, self, foe);
      else if (troop.type === "cannon") this.microCannon(sim, troop, self, foe);
    }
  }

  microSkirmisher(sim, troop, self, foe) {
    const foes = livingInLane(foe, troop.lane);
    const troopMass = foes.filter((f) => f.type === "troop").length;
    // Keep distance from thick infantry; otherwise Advance (skirmishers
    // may shoot Officers and reload while Falling Back only when needed).
    if (troopMass >= 2) {
      this.desireOrder(sim, troop, "fallback");
      return;
    }
    if (troop.order === "reform") return;
    this.desireOrder(sim, troop, null);
  }

  microOfficer(sim, troop, self, foe) {
    const allies = livingInLane(self, troop.lane);
    const foes = livingInLane(foe, troop.lane);
    const cavNear = foes.some((f) => f.type === "dragoon"
      && dist(troop, f) <= CONFIG.dragoonSupportRange);
    if (cavNear) {
      this.desireOrder(sim, troop, "fallback");
      return;
    }
    const many = allies.length >= CONFIG.botOfficerAllyMin;
    if (!many) {
      this.desireOrder(sim, troop, "fallback");
      return;
    }
    const buffRange = unitStats("officer").buffRange || CONFIG.dragoonSupportRange;
    const nearAlly = allies.some((a) => a !== troop && a.type !== "officer"
      && dist(troop, a) <= buffRange);
    if (!nearAlly) {
      this.desireOrder(sim, troop, "fallback");
      return;
    }
    if (troop.order === "fallback" || troop.order === "charge" || troop.order === "halt") {
      this.desireOrder(sim, troop, null);
    }
  }

  microCannon(sim, troop, self, foe) {
    const foes = livingInLane(foe, troop.lane);
    if (troop.order === "charge") {
      this.desireOrder(sim, troop, null);
      return;
    }
    const troopMass = foes.filter((f) => f.type === "troop").length;
    if (troopMass >= CONFIG.botCannonCluster) {
      if (troop.order === "fallback" || troop.order === "halt") {
        this.desireOrder(sim, troop, null);
      }
      return;
    }
    if (foes.length === 0 && (troop.order === "fallback" || troop.order === "halt")) {
      this.desireOrder(sim, troop, null);
    }
  }

  kindAhead(troop, allies, type) {
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === troop || ally.type !== type) continue;
      if (troop.alongSigned(ally) > 0) return true;
    }
    return false;
  }

  kindNear(troop, allies, type, range) {
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === troop || ally.type !== type) continue;
      if (dist(troop, ally) <= range) return true;
    }
    return false;
  }

  enemyNear(troop, foes, range) {
    for (let i = 0; i < foes.length; i += 1) {
      if (foes[i].hp > 0 && dist(troop, foes[i]) <= range) return true;
    }
    return false;
  }

  enemyInEngage(troop, foes) {
    const reach = troop.openFireRange ? troop.openFireRange()
      : (troop.range || UNIT_STATS.dragoon.range) * (troop.engageRange || 0.5);
    for (let i = 0; i < foes.length; i += 1) {
      if (dist(troop, foes[i]) <= reach) return true;
    }
    return false;
  }
}

export { DIFFICULTIES, STRATEGY_MODES, TARGET_MODES };
