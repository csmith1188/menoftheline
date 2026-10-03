import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { CONFIG } from "../shared/config.js";
import { makeSim, spawn } from "./helpers.js";

const flag = "preferNearestRowAmongAlignedTargets";
const previous = CONFIG[flag];

afterEach(() => {
  CONFIG[flag] = previous;
});

describe("preferNearestRowAmongAlignedTargets", () => {
  it("skirmisher prefers the nearer-row officer In Line with the closest officer", () => {
    CONFIG[flag] = true;
    const sim = makeSim();
    const skirm = spawn(sim, "player", "skirmisher", "top", {
      progress: 0.35,
      sublane: 2,
      order: "halt",
    });
    // Same station (equal shot paces); spawn order makes this the primary pick.
    const farRow = spawn(sim, "enemy", "officer", "top", {
      progress: 0.5,
      sublane: 0,
      order: "halt",
    });
    const nearRow = spawn(sim, "enemy", "officer", "top", {
      progress: 0.5,
      sublane: 1,
      order: "halt",
    });
    assert.ok(farRow.withinLine(nearRow));
    assert.equal(skirm.shotPaces(farRow), skirm.shotPaces(nearRow));

    const aim = skirm.nearestTarget(sim.enemy.troops, skirm.shootRange(), sim.player.troops, sim.enemy);
    assert.equal(aim, nearRow);
  });

  it("facing troops each shoot the enemy across their own row", () => {
    CONFIG[flag] = true;
    const sim = makeSim();
    const shooters = [];
    const foes = [];
    for (let row = 0; row < 5; row += 1) {
      shooters.push(spawn(sim, "player", "troop", "top", {
        progress: 0.35,
        sublane: row,
        order: "halt",
      }));
      foes.push(spawn(sim, "enemy", "troop", "top", {
        progress: 0.5,
        sublane: row,
        order: "halt",
      }));
    }
    for (let row = 0; row < 5; row += 1) {
      const aim = shooters[row].nearestTarget(
        sim.enemy.troops,
        shooters[row].shootRange(),
        sim.player.troops,
        sim.enemy,
      );
      assert.equal(aim, foes[row], `row ${row} should shoot across`);
    }
  });

  it("can be disabled to keep pure closest-eligible aiming", () => {
    CONFIG[flag] = false;
    const sim = makeSim();
    const skirm = spawn(sim, "player", "skirmisher", "top", {
      progress: 0.35,
      sublane: 2,
      order: "halt",
    });
    const farRow = spawn(sim, "enemy", "officer", "top", {
      progress: 0.5,
      sublane: 0,
      order: "halt",
    });
    spawn(sim, "enemy", "officer", "top", {
      progress: 0.5,
      sublane: 1,
      order: "halt",
    });
    const aim = skirm.nearestTarget(sim.enemy.troops, skirm.shootRange(), sim.player.troops, sim.enemy);
    assert.equal(aim, farRow);
  });

  it("does not retarget a unit that is not In Line with the closest pick", () => {
    CONFIG[flag] = true;
    const sim = makeSim();
    const troop = spawn(sim, "player", "troop", "top", {
      progress: 0.3,
      sublane: 2,
      order: "halt",
    });
    const closest = spawn(sim, "enemy", "troop", "top", {
      progress: 0.55,
      sublane: 0,
      order: "halt",
    });
    // Same row as shooter but far enough along the lane to leave the line.
    const sameRow = spawn(sim, "enemy", "troop", "top", {
      progress: 0.35,
      sublane: 2,
      order: "halt",
    });
    assert.ok(troop.shotPaces(closest) < troop.shotPaces(sameRow));
    assert.ok(!closest.withinLine(sameRow));
    const aim = troop.nearestTarget(sim.enemy.troops, troop.shootRange(), sim.player.troops, sim.enemy);
    assert.equal(aim, closest);
  });

  it("prefers a slightly farther officer on a nearer row when In Line with the closest", () => {
    CONFIG[flag] = true;
    const sim = makeSim();
    const skirm = spawn(sim, "player", "skirmisher", "top", {
      progress: 0.35,
      sublane: 2,
      order: "halt",
    });
    // More advanced = closer to the skirmisher.
    const farRow = spawn(sim, "enemy", "officer", "top", {
      progress: 0.52,
      sublane: 0,
      order: "halt",
    });
    const nearRow = spawn(sim, "enemy", "officer", "top", {
      progress: 0.515,
      sublane: 1,
      order: "halt",
    });
    assert.ok(farRow.withinLine(nearRow));
    assert.ok(skirm.shotPaces(farRow) < skirm.shotPaces(nearRow));

    const aim = skirm.nearestTarget(sim.enemy.troops, skirm.shootRange(), sim.player.troops, sim.enemy);
    assert.equal(aim, nearRow);
  });
});
