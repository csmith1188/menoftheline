import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeSim, spawn } from "./helpers.js";

/** One sim frame: income then movement/combat. */
function step(sim, dt = 1 / 30) {
  sim.beginStep(dt);
  sim.finishStep(dt);
}

describe("fallback engaged in melee", () => {
  it("halts instead of auto-retreating when a falling-back unit enters melee", () => {
    const sim = makeSim();
    const friend = spawn(sim, "player", "regulars", "top", {
      progress: 0.5,
      sublane: 2,
      order: "fallback",
    });
    const foe = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.5,
      sublane: 2,
      order: "charge",
    });

    assert.equal(friend.isInMelee([foe]), true);
    step(sim);
    assert.equal(friend.order, "halt");
    assert.notEqual(friend.order, "retreat");
  });

  it("still becomes retreat when Fall Back is ordered while already in melee", () => {
    const sim = makeSim();
    const friend = spawn(sim, "player", "regulars", "top", {
      progress: 0.5,
      sublane: 2,
      order: "halt",
    });
    const foe = spawn(sim, "enemy", "regulars", "top", {
      progress: 0.5,
      sublane: 2,
      order: "charge",
    });

    assert.equal(friend.isInMelee([foe]), true);
    friend.issueFallback(sim.player.troops, sim.enemy.troops, true);
    assert.equal(friend.order, "retreat");
  });
});
