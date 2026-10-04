import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeSim, spawn } from "./helpers.js";

/** One sim frame: income then movement/combat. */
function step(sim, dt = 1 / 30) {
  sim.beginStep(dt);
  sim.finishStep(dt);
}

/** Station units covered by 1.0 progress on this unit's path. */
function stationPerProgress(unit) {
  const saved = unit.progress;
  const before = unit.station();
  unit.progress = saved - 0.01;
  unit.syncPosition();
  const after = unit.station();
  unit.progress = saved;
  unit.syncPosition();
  return Math.abs(before - after) / 0.01;
}

describe("reform stays on row", () => {
  it("does not leave its row when a same-row friendly blocks the walk-up", () => {
    const sim = makeSim();
    const front = spawn(sim, "player", "troop", "top", {
      progress: 0.4,
      sublane: 1,
      order: "reform",
    });
    const trailer = spawn(sim, "player", "troop", "top", {
      progress: 0.4,
      sublane: 2,
      order: "reform",
    });
    // Different type so it does not join the reform chain, but still
    // blocks the trailer's walk-up on the same row.
    const blocker = spawn(sim, "player", "skirmisher", "top", {
      progress: 0.4,
      sublane: 2,
      order: "halt",
    });

    const spp = stationPerProgress(front);
    // Trailer stays In Line with the front; blocker sits ahead in the block gap.
    trailer.progress = front.progress - 10 / spp;
    trailer.syncPosition();
    blocker.progress = front.progress - 2 / spp;
    blocker.syncPosition();

    assert.equal(front.withinLine(trailer), true);
    assert.equal(trailer.isBlockedBy(blocker), true);
    assert.equal(front.reformSeekGroup(sim.player.troops).length, 2);

    const startRow = trailer.sublane;
    const startProgress = trailer.progress;
    for (let i = 0; i < 90; i += 1) {
      step(sim);
    }

    assert.equal(trailer.sublane, startRow, "reform must not switch rows around a blocker");
    assert.ok(
      trailer.progress <= startProgress + 1e-6,
      "blocked reformer must not ease past or behind by leaving the row",
    );
    assert.equal(front.sublane, 1);
    assert.equal(blocker.sublane, 2);
  });

  it("walks forward on its own row to square with the front", () => {
    const sim = makeSim();
    const front = spawn(sim, "player", "troop", "top", {
      progress: 0.4,
      sublane: 1,
      order: "reform",
    });
    const trailer = spawn(sim, "player", "troop", "top", {
      progress: 0.39,
      sublane: 2,
      order: "reform",
    });
    const startRow = trailer.sublane;

    for (let i = 0; i < 120; i += 1) {
      step(sim);
    }

    assert.equal(trailer.sublane, startRow);
    assert.equal(front.order, "halt");
    assert.equal(trailer.order, "halt");
    assert.ok(trailer.isParallelTo(front), "trailer should square with the front");
  });
});
