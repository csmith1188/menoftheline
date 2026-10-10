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
    const skirm = spawn(sim, "player", "light", "top", {
      progress: 0.35,
      sublane: 2,
      order: "halt",
    });
    // Same station (equal shot paces); spawn order makes this the primary pick.
    const farRow = spawn(sim, "enemy", "major", "top", {
      progress: 0.5,
      sublane: 0,
      order: "halt",
    });
    const nearRow = spawn(sim, "enemy", "major", "top", {
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
      shooters.push(spawn(sim, "player", "regulars", "top", {
        progress: 0.35,
        sublane: row,
        order: "halt",
      }));
      foes.push(spawn(sim, "enemy", "regulars", "top", {
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
    const skirm = spawn(sim, "player", "light", "top", {
      progress: 0.35,
      sublane: 2,
      order: "halt",
    });
    const farRow = spawn(sim, "enemy", "major", "top", {
      progress: 0.5,
      sublane: 0,
      order: "halt",
    });
    spawn(sim, "enemy", "major", "top", {
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
    const troop = spawn(sim, "player", "regulars", "top", {
      progress: 0.3,
      sublane: 2,
      order: "halt",
    });
    const closest = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.55,
      sublane: 0,
      order: "halt",
    });
    // Same row as shooter but far enough along the lane to leave the line.
    const sameRow = spawn(sim, "enemy", "regulars", "top", {
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
    const skirm = spawn(sim, "player", "light", "top", {
      progress: 0.35,
      sublane: 2,
      order: "halt",
    });
    // More advanced = closer to the skirmisher.
    const farRow = spawn(sim, "enemy", "major", "top", {
      progress: 0.52,
      sublane: 0,
      order: "halt",
    });
    const nearRow = spawn(sim, "enemy", "major", "top", {
      progress: 0.515,
      sublane: 1,
      order: "halt",
    });
    assert.ok(farRow.withinLine(nearRow));
    assert.ok(skirm.shotPaces(farRow) < skirm.shotPaces(nearRow));

    const aim = skirm.nearestTarget(sim.enemy.troops, skirm.shootRange(), sim.player.troops, sim.enemy);
    assert.equal(aim, nearRow);
  });

  it("keep counts as the shooter's row so own-row preference cannot bury keep priority", () => {
    CONFIG[flag] = true;
    const sim = makeSim();
    // On the enemy fort so keep LOS is clear; keep is 200 paces (priority 150).
    const troop = spawn(sim, "player", "regulars", "top", {
      progress: 0.8,
      sublane: 2,
      order: "halt",
    });
    // Slightly closer than keep priority, other row.
    const farRow = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.055,
      sublane: 0,
      order: "halt",
    });
    // Own row, In Line, but farther than keep priority.
    const ownRow = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.045,
      sublane: 2,
      order: "halt",
    });
    assert.ok(farRow.withinLine(ownRow));
    assert.ok(troop.inShotRange(sim.enemy, troop.shootRange()));
    const keepPri = troop.shotPaces(sim.enemy) - CONFIG.keepTargetDistanceOffsetPaces;
    assert.ok(troop.shotPaces(farRow) < keepPri);
    assert.ok(keepPri < troop.shotPaces(ownRow));

    const aim = troop.nearestTarget(
      sim.enemy.troops,
      troop.shootRange(),
      sim.player.troops,
      sim.enemy,
    );
    assert.equal(aim, sim.enemy);
  });
});

describe("guerrilla break-likelihood targeting", () => {
  it("prefers the more wounded and fatigued unit over skirmisher type priority", () => {
    const sim = makeSim();
    const guerilla = spawn(sim, "player", "guerrilla", "top", {
      progress: 0.4,
      sublane: 2,
      order: "advance",
    });
    // Higher enemy progress = closer. Fresh cavalry would win Light priority.
    const cavalry = spawn(sim, "enemy", "dragoon", "top", {
      progress: 0.58,
      sublane: 2,
      order: "halt",
      hp: 200,
      fatigue: 0,
    });
    const troop = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.52,
      sublane: 2,
      order: "halt",
      hp: 100,
      fatigue: 80,
    });
    const range = guerilla.shootRange();
    assert.ok(guerilla.shotPaces(cavalry) < guerilla.shotPaces(troop));
    assert.ok(guerilla.inShotRange(cavalry, range));
    assert.ok(guerilla.inShotRange(troop, range));
    const aim = guerilla.nearestTarget(
      sim.enemy.troops,
      range,
      sim.player.troops,
      sim.enemy,
    );
    assert.equal(aim, troop);
  });

  it("among equal break scores prefers the closer unit", () => {
    const sim = makeSim();
    const guerilla = spawn(sim, "player", "guerrilla", "top", {
      progress: 0.35,
      sublane: 2,
      order: "advance",
    });
    const farther = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.45,
      sublane: 2,
      order: "halt",
      hp: 100,
      fatigue: 50,
    });
    const nearer = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.55,
      sublane: 2,
      order: "halt",
      hp: 100,
      fatigue: 50,
    });
    assert.ok(guerilla.shotPaces(nearer) < guerilla.shotPaces(farther));
    const aim = guerilla.nearestTarget(
      sim.enemy.troops,
      guerilla.shootRange(),
      sim.player.troops,
      sim.enemy,
    );
    assert.equal(aim, nearer);
  });

  it("shoots the keep only when no enemy unit is in range", () => {
    const sim = makeSim();
    const guerilla = spawn(sim, "player", "guerrilla", "top", {
      progress: 0.92,
      sublane: 2,
      order: "advance",
    });
    assert.ok(guerilla.inShotRange(sim.enemy, guerilla.shootRange()));
    const aimEmpty = guerilla.nearestTarget(
      sim.enemy.troops,
      guerilla.shootRange(),
      sim.player.troops,
      sim.enemy,
    );
    assert.equal(aimEmpty, sim.enemy);

    const troop = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.2,
      sublane: 2,
      order: "halt",
      hp: 200,
      fatigue: 0,
    });
    assert.ok(guerilla.inShotRange(troop, guerilla.shootRange()));
    const aimUnit = guerilla.nearestTarget(
      sim.enemy.troops,
      guerilla.shootRange(),
      sim.player.troops,
      sim.enemy,
    );
    assert.equal(aimUnit, troop);
  });
});

describe("melee flank target preference", () => {
  it("prefers an adjacent-row flank over a same-row contact listed first", () => {
    const sim = makeSim();
    const charger = spawn(sim, "player", "regulars", "top", {
      progress: 0.5,
      sublane: 2,
      order: "charge",
    });
    // Listed first: same row, parallel → not a flank.
    const frontal = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    const flanked = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.5,
      sublane: 1,
      order: "halt",
    });
    assert.ok(charger.footprintReaches(frontal));
    assert.ok(charger.footprintReaches(flanked));
    assert.equal(charger.isFlanking(frontal), false);
    assert.equal(charger.isFlanking(flanked), true);
    assert.equal(charger.collidingEnemy([frontal, flanked]), flanked);
  });

  it("keeps the closest contact when neither is a flank", () => {
    const sim = makeSim();
    const unit = spawn(sim, "player", "regulars", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    const farther = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.5,
      sublane: 1,
      order: "halt",
    });
    const nearer = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    assert.equal(unit.isFlanking(farther), false);
    assert.equal(unit.isFlanking(nearer), false);
    assert.equal(unit.collidingEnemy([farther, nearer]), nearer);
  });
});
