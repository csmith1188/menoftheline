import { CONFIG } from "../shared/config.js";
import { UNIT_STATS } from "../shared/units.js";

/** This side's fraction of a lane. Empty lanes stay at one half. */
function sideShare(sim, side, lane) {
  const center = sim.laneCenterT(lane);
  return side.id === "player" ? center : 1 - center;
}

/**
 * Built-in opponent. Decides from the live sim and writes orders itself
 * so the core step never mentions bots. Either seat can hold one.
 */
export class BotController {
  constructor(sideId) {
    this.sideId = sideId;
    this.locks = new Map();
  }

  act(sim) {
    if (sim.winner) return;
    const self = sim.side(this.sideId);
    const foe = sim.side(this.sideId === "player" ? "enemy" : "player");
    this.formLines(sim, self, foe);
    this.chargeDragoons(sim, self, foe);
    this.buyUpgrades(self);
    const emptyLane = this.laneMissingTroop(sim, self);
    if (emptyLane) {
      sim.grantTroop(self, emptyLane, "troop");
      return;
    }
    if (this.shouldSaveForBank(sim, self, foe)) {
      self.tryUnlockBank();
      return;
    }
    const topShare = sideShare(sim, self, "top");
    const bottomShare = sideShare(sim, self, "bottom");
    const lane = bottomShare < topShare ? "bottom" : "top";
    if (self.countInLane(lane) > foe.countInLane(lane)) {
      sim.grantTroop(self, lane, "dragoon");
      self.tryUnlockBank();
      return;
    }
    if (self.gold < UNIT_STATS.troop.cost) {
      self.tryUnlockBank();
      return;
    }
    sim.grantTroop(self, lane, "troop");
    self.tryUnlockBank();
  }

  locked(sim, troop) {
    return sim.elapsed < (this.locks.get(troop.id) || 0);
  }

  /** Apply an order if it changed and this bot's lock has expired. */
  setOrder(sim, troop, next) {
    if (troop.broken || troop.order === next || this.locked(sim, troop)) return false;
    troop.order = next;
    troop.reformNeedsAlign = next === "reform";
    troop.wantedSublane = null;
    this.locks.set(troop.id, sim.elapsed + CONFIG.botOrderCooldown);
    return true;
  }

  /**
   * Lane with no living bot troop. If both are empty, use the
   * weaker center-line share (ties: top).
   */
  laneMissingTroop(sim, self) {
    const topEmpty = self.countTypeInLane("top", "troop") === 0;
    const bottomEmpty = self.countTypeInLane("bottom", "troop") === 0;
    if (!topEmpty && !bottomEmpty) return null;
    if (topEmpty && !bottomEmpty) return "top";
    if (bottomEmpty && !topEmpty) return "bottom";
    const topShare = sideShare(sim, self, "top");
    const bottomShare = sideShare(sim, self, "bottom");
    return bottomShare < topShare ? "bottom" : "top";
  }

  /**
   * Dragoon (and dragoon-line) orders, first match:
   * no troop within 100 → fallback; enemy within 100 → charge;
   * troop within 100 behind → reform; otherwise advance.
   */
  chargeDragoons(sim, self, foe) {
    const allies = self.troops;
    const foes = foe.troops;
    const seen = {};
    for (let i = 0; i < allies.length; i += 1) {
      const troop = allies[i];
      if (troop.hp <= 0 || troop.type !== "dragoon" || seen[troop.id]) continue;
      if (troop.sameRowMate(allies)) continue;
      const line = troop.lineGroup(allies);
      const lead = troop.sortRearToFront(line)[line.length - 1];
      const next = this.dragoonOrder(lead, allies, foes);
      let locked = false;
      for (let g = 0; g < line.length; g += 1) {
        seen[line[g].id] = true;
        if (line[g].order !== next && this.locked(sim, line[g])) locked = true;
      }
      if (locked) continue;
      for (let g = 0; g < line.length; g += 1) {
        this.setOrder(sim, line[g], next);
      }
    }
  }

  dragoonOrder(dragoon, allies, foes) {
    return dragoon.supportOrder(allies, foes);
  }

  /**
   * True when the next bank is time-unlocked and this side's living
   * unit gold-value is ahead in both lanes.
   */
  shouldSaveForBank(sim, self, foe) {
    if (self.banks >= CONFIG.bankCount || !self.bankUnlockedByTime(self.banks)) return false;
    return sim.laneArmyValue(self, "top") > sim.laneArmyValue(foe, "top")
      && sim.laneArmyValue(self, "bottom") > sim.laneArmyValue(foe, "bottom");
  }

  /**
   * If a lane has more than one troop, only a lone leader that is
   * ahead of an adjacent follower reforms. Troops that can walk up into
   * a line already ahead keep advancing, as do already-formed lines.
   */
  formLines(sim, self, foe) {
    const allies = self.troops;
    const foes = foe.troops;
    const lanes = ["top", "bottom"];
    for (let L = 0; L < lanes.length; L += 1) {
      const lane = lanes[L];
      let count = 0;
      for (let i = 0; i < allies.length; i += 1) {
        if (allies[i].hp > 0 && allies[i].lane === lane) count += 1;
      }
      if (count < 2) continue;
      for (let i = 0; i < allies.length; i += 1) {
        const troop = allies[i];
        if (troop.hp <= 0 || troop.lane !== lane || troop.type === "dragoon") continue;
        if (troop.sameRowMate(allies)) continue;
        if (troop.order === "charge" || troop.order === "halt" || troop.order === "fallback") continue;
        if (troop.lineInMelee(allies, foes)) continue;
        const line = troop.lineGroup(allies);
        if (line.length >= 2) {
          if (troop.order === "reform") {
            for (let g = 0; g < line.length; g += 1) {
              if (line[g].order === "reform") this.setOrder(sim, line[g], null);
            }
          }
          continue;
        }
        if (troop.canJoinLineAhead(allies)) {
          if (troop.order === "reform") this.setOrder(sim, troop, null);
          continue;
        }
        if (troop.order === "reform") continue;
        const partner = troop.nextBehindOtherSublane(allies);
        if (!partner) continue;
        this.setOrder(sim, troop, "reform");
      }
    }
  }

  /** Spend land on an owned town's upgrade when it can afford one. */
  buyUpgrades(self) {
    let best = null;
    let bestCost = Infinity;
    const towns = self.sim.checkpoints;
    for (let i = 0; i < towns.length; i += 1) {
      const town = towns[i];
      if (town.owner !== self.id) continue;
      const kind = town.upgradeKind();
      if (self.upgrades[kind] >= CONFIG.upgradeMax) continue;
      const cost = self.upgradeCost(kind);
      if (cost < bestCost && self.canBuyUpgrade(kind)) {
        bestCost = cost;
        best = kind;
      }
    }
    if (best) self.tryBuyUpgrade(best);
  }
}
