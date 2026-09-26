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
    if (ok) this.locks.set(troop.id, sim.elapsed + CONFIG.botOrderCooldown);
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
   * Move a whole line one row in dir (+1 / -1). Prefer this over peeling
   * a single member out of formation.
   */
  shiftLine(sim, troop, dir, allies) {
    if (!troop || troop.hp <= 0 || troop.broken || this.locked(sim, troop)) {
      return false;
    }
    if (dir !== 1 && dir !== -1) return false;
    const ok = this.cmd(sim, {
      type: "order",
      troopId: troop.id,
      action: "shift",
      dir,
      solo: false,
    });
    if (ok) {
      const line = troop.lineGroup(allies);
      const until = sim.elapsed + CONFIG.botOrderCooldown;
      this.locks.set(troop.id, until);
      for (let i = 0; i < line.length; i += 1) {
        this.locks.set(line[i].id, until);
      }
    }
    return ok;
  }

  /**
   * Move toward a desired speed/order using player-equivalent actions.
   * desired: null | "halt" | "charge" | "fallback" | "reform"
   */
  desireOrder(sim, troop, desired) {
    if (!troop || troop.hp <= 0 || troop.broken || this.locked(sim, troop)) {
      return false;
    }
    const current = troop.orderHeld ? troop.heldOrder : troop.order;
    if (desired === "reform") {
      if (current === "reform") return false;
      return this.order(sim, troop, "reform", false);
    }
    if (current === "reform") {
      if (desired === null) return this.order(sim, troop, "restore", false);
      // Charge and fallback may interrupt reform.
      if (desired === "charge") return this.order(sim, troop, "charge", true);
      if (desired === "fallback") return this.order(sim, troop, "fallback", true);
      return false;
    }
    if (desired === "charge") {
      if (current === "charge") return false;
      return this.order(sim, troop, "charge", true);
    }
    if (desired === "fallback") {
      if (current === "fallback" || current === "retreat") return false;
      return this.order(sim, troop, "fallback", true);
    }
    if (desired === "halt") {
      if (current === "halt") return false;
      if (current === "charge" || current === null) {
        return this.order(sim, troop, "speedDown", true);
      }
      if (current === "fallback" || current === "retreat") {
        return this.order(sim, troop, "speedUp", true);
      }
      return false;
    }
    // Advance (null).
    if (current === null) return false;
    if (current === "charge") return this.order(sim, troop, "back", true);
    if (current === "halt" || current === "fallback" || current === "retreat") {
      return this.order(sim, troop, "speedUp", true);
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
   * Highest-priority movement: get line units onto adjacent rows, square
   * them with reform, and keep them advancing together once parallel.
   * Returns ids still busy forming so Hard micro does not override them.
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
      if (troop.lineInMelee(allies, foe.troops)) continue;

      const line = troop.lineGroup(units);
      const inLine = line.length >= 2;
      const squared = inLine && this.lineIsSquared(line);

      // Formed lines: never peel a single member to another row. Close
      // gaps by shifting the whole line, then keep depth orders.
      if (inLine) {
        if (!seenLine.has(line[0].id)) {
          for (let g = 0; g < line.length; g += 1) seenLine.add(line[g].id);
          const outsider = this.nearestOutsideLine(line, units);
          if (outsider) {
            const mid = this.lineMiddleRow(line);
            const gap = outsider.sublane - mid;
            if (Math.abs(gap) > 1) {
              const dir = gap > 0 ? 1 : -1;
              if (this.shiftLine(sim, troop, dir, units)) {
                for (let g = 0; g < line.length; g += 1) busy.add(line[g].id);
                continue;
              }
            }
          }
        }

        if (squared) {
          if (troop.order === "reform") this.desireOrder(sim, troop, null);
          else if (troop.order === "charge" || troop.order === "halt"
            || troop.order === "fallback" || troop.order === "retreat") {
            this.desireOrder(sim, troop, null);
          }
        } else {
          this.desireOrder(sim, troop, "reform");
        }
        busy.add(troop.id);
        continue;
      }

      // Lone units only: unstack or step toward a partner. Never break a line.
      const mate = troop.sameRowMate(units);
      if (mate) {
        // Prefer moving the unit that is not anchored to adjacent-row allies.
        const mateLine = mate.lineGroup(units);
        if (mateLine.length >= 2) {
          // Mate is in a real line; peel this lone stacker only.
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

      // Can walk up into a line ahead: advance (do not reform).
      if (troop.canJoinLineAhead(units)) {
        if (troop.order === "reform" || troop.order === "charge"
          || troop.order === "halt" || troop.order === "fallback"
          || troop.order === "retreat") {
          this.desireOrder(sim, troop, null);
        }
        busy.add(troop.id);
        continue;
      }

      // Someone same-type on an adjacent row behind: reform to square.
      const behind = troop.nextBehindOtherSublane(units);
      if (behind) {
        this.desireOrder(sim, troop, "reform");
        busy.add(troop.id);
        continue;
      }

      const ahead = troop.nextAheadOtherSublane(units);
      if (ahead) {
        if (troop.order === "reform") this.desireOrder(sim, troop, null);
        busy.add(troop.id);
      }
    }
  }

  lineIsSquared(line) {
    if (!line || line.length < 2) return false;
    const lead = line[0];
    for (let i = 1; i < line.length; i += 1) {
      if (!lead.isParallelTo(line[i])) return false;
    }
    return true;
  }

  lineMiddleRow(line) {
    let sum = 0;
    for (let i = 0; i < line.length; i += 1) sum += line[i].sublane;
    return sum / line.length;
  }

  /** Closest same-type unit that is not already in this line group. */
  nearestOutsideLine(line, units) {
    const inLine = {};
    for (let i = 0; i < line.length; i += 1) inLine[line[i].id] = true;
    let best = null;
    let bestD = Infinity;
    const anchor = line[0];
    for (let i = 0; i < units.length; i += 1) {
      const other = units[i];
      if (inLine[other.id]) continue;
      const d = dist(anchor, other);
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
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

  leashCavalry(sim, self, foe) {
    const range = CONFIG.dragoonSupportRange;
    for (let i = 0; i < self.troops.length; i += 1) {
      const troop = self.troops[i];
      if (troop.hp <= 0 || troop.broken || troop.type !== "dragoon") continue;
      const allies = livingInLane(self, troop.lane);
      const foes = livingInLane(foe, troop.lane);
      const hasTroopNear = this.kindNear(troop, allies, "troop", range);
      const hasTroopAhead = this.kindAhead(troop, allies, "troop");
      // Do not wander alone past the infantry.
      if (!hasTroopNear) {
        this.desireOrder(sim, troop, "fallback");
        continue;
      }
      // Charge when enemies are in reach — even with troops ahead.
      if (this.enemyInEngage(troop, foes) || this.enemyNear(troop, foes, range)) {
        this.desireOrder(sim, troop, "charge");
        continue;
      }
      // No fight yet: stay behind the line, do not outrun infantry.
      if (hasTroopAhead) {
        this.desireOrder(sim, troop, null);
        continue;
      }
      if (this.kindBehind(troop, allies, "troop", range)) {
        this.desireOrder(sim, troop, "reform");
        continue;
      }
      this.desireOrder(sim, troop, null);
    }
  }

  // --- Orders: Hard ---

  hardOrders(sim, self, foe, desperate) {
    const forming = this.formLines(sim, self, foe);
    for (let i = 0; i < self.troops.length; i += 1) {
      const troop = self.troops[i];
      if (troop.hp <= 0 || troop.broken) continue;
      // Line work wins over survival and type micro.
      if (forming.has(troop.id)) continue;
      if (!desperate && vitality(troop) < CONFIG.botSurvivalVitality) {
        if (troop.order !== "fallback" && troop.order !== "retreat") {
          this.desireOrder(sim, troop, troop.order === "halt" ? "fallback" : "halt");
        }
        continue;
      }
      if (troop.type === "skirmisher") this.microSkirmisher(sim, troop, self, foe);
      else if (troop.type === "officer") this.microOfficer(sim, troop, self, foe);
      else if (troop.type === "dragoon") this.microDragoon(sim, troop, self, foe);
      else if (troop.type === "cannon") this.microCannon(sim, troop, self, foe);
    }
  }

  microSkirmisher(sim, troop, self, foe) {
    const foes = livingInLane(foe, troop.lane);
    const hasCavOrOff = foes.some((f) => f.type === "dragoon" || f.type === "officer");
    const troopLine = foes.filter((f) => f.type === "troop").length >= 2;
    const loneCav = foes.filter((f) => f.type === "dragoon").length === 1
      && foes.filter((f) => f.type === "troop").length === 0;
    if (troopLine || loneCav) {
      this.desireOrder(sim, troop, "fallback");
      return;
    }
    if (hasCavOrOff) {
      this.desireOrder(sim, troop, null);
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
    const nearAlly = allies.some((a) => a !== troop && a.type !== "officer"
      && dist(troop, a) <= (unitStats("officer").buffRange || CONFIG.dragoonSupportRange));
    if (!nearAlly) this.desireOrder(sim, troop, "fallback");
    else if (troop.order === "fallback" || troop.order === "charge") {
      this.desireOrder(sim, troop, null);
    }
  }

  microDragoon(sim, troop, self, foe) {
    const range = CONFIG.dragoonSupportRange;
    const allies = livingInLane(self, troop.lane);
    const foes = livingInLane(foe, troop.lane);
    const hasTroopNear = this.kindNear(troop, allies, "troop", range)
      || this.kindNear(troop, allies, "skirmisher", range);
    const hasTroopAhead = this.kindAhead(troop, allies, "troop")
      || this.kindAhead(troop, allies, "skirmisher");
    if (!hasTroopNear) {
      this.desireOrder(sim, troop, "fallback");
      return;
    }
    if (this.enemyInEngage(troop, foes) || this.enemyNear(troop, foes, range)) {
      this.desireOrder(sim, troop, "charge");
      return;
    }
    if (hasTroopAhead) {
      this.desireOrder(sim, troop, null);
      return;
    }
    if (this.kindBehind(troop, allies, "troop", range)
      || this.kindBehind(troop, allies, "skirmisher", range)) {
      this.desireOrder(sim, troop, "reform");
      return;
    }
    this.desireOrder(sim, troop, null);
  }

  microCannon(sim, troop, self, foe) {
    const foes = livingInLane(foe, troop.lane);
    const troopMass = foes.filter((f) => f.type === "troop").length;
    if (troop.order === "charge") {
      this.desireOrder(sim, troop, "back");
      return;
    }
    if (troopMass >= CONFIG.botCannonCluster) {
      if (troop.order === "fallback" || troop.order === "halt") {
        this.desireOrder(sim, troop, null);
      }
      return;
    }
    if (foes.length === 0) this.desireOrder(sim, troop, null);
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

  kindBehind(troop, allies, type, range) {
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === troop || ally.type !== type) continue;
      if (troop.alongSigned(ally) >= 0) continue;
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
