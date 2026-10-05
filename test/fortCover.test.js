import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG } from "../shared/config.js";
import {
  fortColorHalfPaces,
  fortFootprintPaces,
  fortsClearOfEnemies,
} from "../shared/path.js";
import { makeSim, spawn } from "./helpers.js";

/** Progress on the top lane for a given paces-from-own-keep. */
function progressAtPaces(paces) {
  return paces / CONFIG.topLanePaces;
}

/** Enemy progress that lands on a player-keep pace. */
function enemyAtPlayerPaces(paces) {
  return 1 - paces / CONFIG.topLanePaces;
}

describe("fort cover", () => {
  it("covers a friendly standing in the footprint against an outsider", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort),
      sublane: 2,
      hp: 100,
    });
    const attacker = spawn(sim, "enemy", "troop", "top", {
      progress: enemyAtPlayerPaces(fort + fortFootprintPaces() + 40),
      sublane: 2,
    });
    defender.takeDamage(10, "shoot", 0, 0, attacker);
    assert.equal(100 - defender.hp, 10 * (1 - CONFIG.quarterArmor));
  });

  it("does not cover a unit outside the footprint, even behind the fort", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort - fortFootprintPaces() - 20),
      sublane: 2,
      hp: 100,
    });
    const attacker = spawn(sim, "enemy", "troop", "top", {
      progress: enemyAtPlayerPaces(fort + fortFootprintPaces() + 40),
      sublane: 2,
    });
    defender.takeDamage(10, "shoot", 0, 0, attacker);
    assert.equal(100 - defender.hp, 10);
  });

  it("does not cover when the attacker is inside the same footprint", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort),
      sublane: 2,
      hp: 100,
    });
    const attacker = spawn(sim, "enemy", "troop", "top", {
      progress: enemyAtPlayerPaces(fort + fortColorHalfPaces()),
      sublane: 0,
    });
    defender.takeDamage(10, "shoot", 0, 0, attacker);
    assert.equal(100 - defender.hp, 10);
  });

  it("does not give the enemy cover for standing in your fort", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "enemy", "troop", "top", {
      progress: enemyAtPlayerPaces(fort),
      sublane: 2,
      hp: 100,
    });
    const attacker = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort + fortFootprintPaces() + 40),
      sublane: 2,
    });
    defender.takeDamage(10, "shoot", 0, 0, attacker);
    assert.equal(100 - defender.hp, 10);
  });

  it("covers a unit in the footprint against the enemy keep gun", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const inside = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort),
      sublane: 2,
      hp: 100,
    });
    const behind = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort - fortFootprintPaces() - 20),
      sublane: 0,
      hp: 100,
    });
    assert.equal(inside.incomingMultiplier("shoot", sim.enemy), 1 - CONFIG.quarterArmor);
    assert.equal(behind.incomingMultiplier("shoot", sim.enemy), 1);
  });

  it("keeps the clear-fort check for keep restore, separate from cover", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort),
      sublane: 2,
    });
    assert.equal(fortsClearOfEnemies("player", sim.enemy.troops), true);
    spawn(sim, "enemy", "troop", "top", {
      progress: enemyAtPlayerPaces(fort - 10),
      sublane: 2,
    });
    assert.equal(fortsClearOfEnemies("player", sim.enemy.troops), false);
  });

  it("slows enemies in the colored band and not friendlies or units only in the footprint", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const enemy = spawn(sim, "enemy", "guerrilla", "top", {
      progress: enemyAtPlayerPaces(fort),
      sublane: 2,
    });
    const friendly = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort),
      sublane: 2,
    });
    const wide = spawn(sim, "enemy", "troop", "top", {
      progress: enemyAtPlayerPaces(fort + fortColorHalfPaces() + 4),
      sublane: 1,
    });
    const onOwn = spawn(sim, "enemy", "troop", "top", {
      progress: progressAtPaces(fort),
      sublane: 0,
    });
    assert.equal(enemy.terrainMoveFactor(), CONFIG.fortColorSlow);
    assert.equal(friendly.terrainMoveFactor(), 1);
    assert.ok(Math.abs(wide.pacesFromKeep("player") - fort) > fortColorHalfPaces());
    assert.ok(Math.abs(wide.pacesFromKeep("player") - fort) < fortFootprintPaces());
    assert.equal(wide.terrainMoveFactor(), 1);
    assert.equal(onOwn.terrainMoveFactor(), 1);
  });
});
