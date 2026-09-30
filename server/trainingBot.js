import {
  TRAINING_BOT_BUY_INTERVAL_SEC,
  TRAINING_BOT_START_SEC,
} from "./training.js";

/**
 * Minimal training opponent: buy one bottom-lane troop on a timer after a
 * delay, and advance unbroken units. No other AI.
 */
export class TrainingBotController {
  constructor(sideId) {
    this.sideId = sideId;
    /** Next sim.elapsed (seconds) when a troop may be bought. */
    this.nextBuyAt = TRAINING_BOT_START_SEC;
  }

  act(sim) {
    if (!sim || sim.winner) return;
    const self = sim.side(this.sideId);
    if (!self) return;

    if (sim.elapsed >= this.nextBuyAt) {
      const bought = sim.applyCommand(this.sideId, {
        type: "buy",
        lane: "bottom",
        unit: "troop",
      });
      if (bought) {
        this.nextBuyAt = sim.elapsed + TRAINING_BOT_BUY_INTERVAL_SEC;
      } else {
        // Retry soon if gold was short; do not skip the cadence forever.
        this.nextBuyAt = sim.elapsed + 1;
      }
    }

    const troops = self.troops || [];
    for (let i = 0; i < troops.length; i += 1) {
      const troop = troops[i];
      if (!troop || troop.hp <= 0 || troop.broken) continue;
      const current = troop.orderHeld ? troop.heldOrder : troop.order;
      if (current === null) continue;
      this.issueAdvance(sim, troop, current);
    }
  }

  issueAdvance(sim, troop, current) {
    if (current === "reform") {
      sim.applyCommand(this.sideId, {
        type: "order",
        troopId: troop.id,
        action: "restore",
        solo: false,
      });
      return;
    }
    if (current === "charge") {
      sim.applyCommand(this.sideId, {
        type: "order",
        troopId: troop.id,
        action: "speedDown",
        solo: false,
      });
      return;
    }
    if (current === "halt" || current === "fallback" || current === "retreat") {
      sim.applyCommand(this.sideId, {
        type: "order",
        troopId: troop.id,
        action: "speedUp",
        solo: false,
      });
    }
  }
}
