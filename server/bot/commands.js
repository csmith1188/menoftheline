import { CONFIG } from "../../shared/config.js";

/**
 * Player-equivalent orders. One call issues one command and starts the
 * cooldown. Group orders lock the whole geometric line so a later unit
 * in the same think cannot peel it.
 */
export function bindCommands(bot) {
  function locked(sim, troop) {
    return sim.elapsed < (bot.locks.get(troop.id) || 0);
  }

  function rememberLock(sim, troop, solo) {
    const until = sim.elapsed + CONFIG.botOrderCooldown;
    bot.locks.set(troop.id, until);
    if (!solo && troop.side) {
      const line = troop.lineGroup(troop.side.troops);
      for (let i = 0; i < line.length; i += 1) {
        bot.locks.set(line[i].id, until);
      }
    }
  }

  function order(sim, troop, action, solo, lock) {
    if (!troop || troop.hp <= 0 || troop.broken || locked(sim, troop)) return false;
    const useSolo = solo != null
      ? Boolean(solo)
      : action !== "reform" && action !== "restore";
    const ok = sim.applyCommand(bot.sideId, {
      type: "order",
      troopId: troop.id,
      action,
      solo: useSolo,
    });
    if (ok && lock !== false) rememberLock(sim, troop, useSolo);
    return ok;
  }

  /** Slide one step toward an exact sublane. Lone units only. */
  function switchRow(sim, troop, sublane) {
    if (!troop || troop.hp <= 0 || troop.broken || locked(sim, troop)) return false;
    if (troop.switchBlocked && troop.switchBlocked()) return false;
    if (sublane === troop.sublane) return false;
    const ok = sim.applyCommand(bot.sideId, {
      type: "order",
      troopId: troop.id,
      action: "lane",
      sublane,
      solo: true,
    });
    if (ok) bot.locks.set(troop.id, sim.elapsed + CONFIG.botOrderCooldown);
    return ok;
  }

  /**
   * Step toward a desired order with the same actions a player uses.
   * Advance and Halt move a whole line unless `solo` is true.
   * Charge and Fallback peel unless `solo` is explicitly false.
   */
  function desireOrder(sim, troop, desired, solo, lock) {
    if (!troop || troop.hp <= 0 || troop.broken || locked(sim, troop)) return false;
    const current = troop.orderHeld ? troop.heldOrder : troop.order;
    const peel = solo != null ? Boolean(solo) : true;
    if (desired === "reform") {
      if (current === "reform") return false;
      return order(sim, troop, "reform", false, lock);
    }
    if (current === "reform") {
      if (desired === null || desired === "advance") return order(sim, troop, "restore", false, lock);
      if (desired === "charge") return order(sim, troop, "charge", peel, lock);
      if (desired === "fallback") return order(sim, troop, "fallback", peel, lock);
      return false;
    }
    if (desired === "charge") {
      if (current === "charge") return false;
      return order(sim, troop, "charge", peel, lock);
    }
    if (desired === "fallback") {
      if (current === "fallback" || current === "retreat") return false;
      return order(sim, troop, "fallback", peel, lock);
    }
    if (desired === "halt") {
      if (current === "halt") return false;
      const alone = solo === true;
      if (current === "charge" || current === null) return order(sim, troop, "speedDown", alone, lock);
      if (current === "fallback" || current === "retreat") return order(sim, troop, "speedUp", alone, lock);
      return false;
    }
    const alone = solo === true;
    if (current === null) return false;
    if (current === "charge") return order(sim, troop, "speedDown", alone, lock);
    if (current === "halt" || current === "fallback" || current === "retreat") {
      return order(sim, troop, "speedUp", alone, lock);
    }
    return false;
  }

  function prune(sim) {
    const side = sim.side(bot.sideId);
    const living = new Set();
    for (let i = 0; i < side.troops.length; i += 1) {
      const unit = side.troops[i];
      if (unit.hp > 0) living.add(unit.id);
    }
    for (const id of bot.locks.keys()) {
      if (!living.has(id)) bot.locks.delete(id);
    }
    for (const id of bot.unitMemory.keys()) {
      if (!living.has(id)) bot.unitMemory.delete(id);
    }
  }

  return { locked, order, switchRow, desireOrder, prune };
}
