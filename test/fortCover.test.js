import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG } from "../shared/config.js";
import {
  fortFootprintPaces,
  fortsClearOfEnemies,
  hasFortCover,
  inOwnFortCoverZone,
} from "../shared/path.js";
import { makeSim, spawn } from "./helpers.js";

/** Progress on the top lane for a given paces-from-own-keep. */
function progressAtPaces(paces) {
  return paces / CONFIG.topLanePaces;
}

describe("fort cover", () => {
  it("covers a unit on its fort when the attacker is past the fort", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort),
      sublane: 2,
    });
    const attacker = spawn(sim, "enemy", "troop", "top", {
      progress: progressAtPaces(fort + fortFootprintPaces() + 40),
      sublane: 2,
    });
    assert.equal(hasFortCover(defender, attacker), true);
    assert.ok(defender.incomingMultiplier("shoot", attacker) < 1);
  });

  it("covers a unit behind its fort when the attacker is past the fort", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort - 80),
      sublane: 2,
    });
    const attacker = spawn(sim, "enemy", "troop", "top", {
      progress: progressAtPaces(fort + fortFootprintPaces() + 40),
      sublane: 2,
    });
    assert.equal(hasFortCover(defender, attacker), true);
  });

  it("does not cover when the attacker is also behind the fort", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort - 80),
      sublane: 2,
    });
    const attacker = spawn(sim, "enemy", "troop", "top", {
      // Enemy deep past player fort toward player keep → behind player fort.
      progress: 1 - progressAtPaces(fort - 40),
      sublane: 2,
    });
    assert.equal(hasFortCover(defender, attacker), false);
  });

  it("does not cover when the attacker stands in the fort footprint", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort - 80),
      sublane: 2,
    });
    const attacker = spawn(sim, "enemy", "troop", "top", {
      progress: 1 - progressAtPaces(fort),
      sublane: 2,
    });
    assert.equal(attacker.pacesFromKeep("player"), fort);
    assert.equal(hasFortCover(defender, attacker), false);
  });

  it("does not cover a unit past its fort", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort + fortFootprintPaces() + 40),
      sublane: 2,
    });
    const attacker = spawn(sim, "enemy", "troop", "top", {
      progress: progressAtPaces(fort + fortFootprintPaces() + 120),
      sublane: 2,
    });
    assert.equal(hasFortCover(defender, attacker), false);
  });

  it("reduces takeDamage when cover applies", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const covered = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort - 40),
      sublane: 2,
      hp: 100,
    });
    const open = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort + fortFootprintPaces() + 80),
      sublane: 0,
      hp: 100,
    });
    const attacker = spawn(sim, "enemy", "troop", "top", {
      progress: progressAtPaces(fort + fortFootprintPaces() + 200),
      sublane: 2,
    });
    covered.takeDamage(10, "shoot", 0, 0, attacker);
    open.takeDamage(10, "shoot", 0, 0, attacker);
    const coveredHit = 100 - covered.hp;
    const openHit = 100 - open.hp;
    assert.equal(coveredHit, 10 * (1 - CONFIG.quarterArmor));
    assert.equal(openHit, 10);
  });

  it("grants cover against the enemy keep gun from behind the fort", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort - 40),
      sublane: 2,
    });
    assert.equal(hasFortCover(defender, sim.enemy), true);
  });

  it("unit-info cover zone needs a clear fort line (keep helper)", () => {
    const sim = makeSim();
    const fort = CONFIG.fortDistancePaces;
    const defender = spawn(sim, "player", "troop", "top", {
      progress: progressAtPaces(fort - 40),
      sublane: 2,
    });
    assert.equal(inOwnFortCoverZone(defender), true);
    assert.equal(fortsClearOfEnemies("player", sim.enemy.troops), true);

    spawn(sim, "enemy", "troop", "top", {
      progress: 1 - progressAtPaces(fort - 10),
      sublane: 2,
    });
    assert.equal(fortsClearOfEnemies("player", sim.enemy.troops), false);
    assert.equal(defender.fortsClearOfEnemies(), false);
  });
});
