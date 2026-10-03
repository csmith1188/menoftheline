import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Path } from "../shared/path.js";
import { CONFIG } from "../shared/config.js";
import { makeSim, spawn } from "./helpers.js";

/** Place rear just outside the front's block gap on the same row. */
function stackJustClear(front, rear, pacesOutside = 0.5) {
  const gapPaces = (front.stationSlack("block") / Path.stationPerPace(front.lane))
    + pacesOutside;
  rear.progress = front.progress - gapPaces / Path.lanePaces(front.lane);
  rear.syncPosition();
}

/** Drain queued pushback one instant pace per call. */
function finishPushback(unit, allies, steps = 40) {
  for (let i = 0; i < steps && unit.pushbackQueue.length > 0; i += 1) {
    unit.tickPushback(0, allies);
  }
}

describe("pushback vs friendly ranks", () => {
  it("does not push the front rank into a friendly behind", () => {
    const sim = makeSim();
    const front = spawn(sim, "player", "troop", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    const rear = spawn(sim, "player", "troop", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    const allies = [front, rear];
    stackJustClear(front, rear);
    assert.equal(front.pushbackBlocked(allies), false);
    assert.equal(front.collidingAlly(allies), null);

    const start = front.progress;
    const fatigueBefore = front.fatigue;
    front.applyPushback(CONFIG.pushbackPerPace, true);
    finishPushback(front, allies);

    assert.equal(front.progress, start, "front stays put when the pace would enter the rear");
    assert.equal(front.collidingAlly(allies), null);
    assert.ok(front.fatigue > fatigueBefore, "blocked hit pushback still costs fatigue");
    void rear;
  });

  it("keeps firing after a blocked pushback pace against a deep line", () => {
    const sim = makeSim();
    const front = spawn(sim, "player", "troop", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    const rear = spawn(sim, "player", "troop", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    const foe = spawn(sim, "enemy", "troop", "top", {
      progress: 0.72,
      sublane: 2,
      order: "halt",
    });
    const allies = [front, rear];
    const enemies = [foe];
    stackJustClear(front, rear);

    front.applyPushback(CONFIG.pushbackPerPace, true);
    finishPushback(front, allies);

    assert.equal(front.collidingAlly(allies), null);
    assert.equal(front.mayShoot(allies, enemies, sim.enemy), true);
    assert.equal(rear.mayShoot(allies, enemies, sim.enemy), true);

    const projectiles = [];
    front.fire(foe, allies, projectiles, "shoot");
    rear.fire(foe, allies, projectiles, "shoot");
    assert.equal(projectiles.length, 2);
  });

  it("applies stacked paces one instant step at a time", () => {
    const sim = makeSim();
    const unit = spawn(sim, "player", "troop", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    const pace = unit.pushbackPaceDelta();
    const start = unit.progress;
    unit.applyPushback(CONFIG.pushbackPerPace * 2, true);
    assert.equal(unit.pushbackQueue.length, 2);

    unit.tickPushback(0, []);
    assert.equal(unit.pushbackQueue.length, 1);
    assert.ok(Math.abs(unit.progress - (start - pace)) < 1e-9);

    unit.tickPushback(0, []);
    assert.equal(unit.pushbackQueue.length, 0);
    assert.ok(Math.abs(unit.progress - (start - 2 * pace)) < 1e-9);
  });

  it("still allows shooting if ranks are already overlapping", () => {
    const sim = makeSim();
    const front = spawn(sim, "player", "troop", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    const rear = spawn(sim, "player", "troop", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    // Force a deep stack inside the block gap.
    rear.progress = front.progress - 10 / Path.lanePaces(front.lane);
    rear.syncPosition();
    const allies = [front, rear];
    assert.ok(front.collidingAlly(allies));
    assert.ok(rear.collidingAlly(allies));

    const foe = spawn(sim, "enemy", "troop", "top", {
      progress: 0.72,
      sublane: 2,
      order: "halt",
    });
    const projectiles = [];
    front.fire(foe, allies, projectiles, "shoot");
    rear.fire(foe, allies, projectiles, "shoot");
    assert.equal(projectiles.length, 2);
  });
});
