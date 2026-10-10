import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Path } from "../shared/path.js";
import { CONFIG } from "../shared/config.js";
import { makeSim, spawn } from "./helpers.js";

/** Shift a unit along the lane by a signed pace gap from a base unit. */
function placeGap(base, unit, paces) {
  unit.progress = base.progress + paces / Path.lanePaces(base.lane);
  unit.syncPosition();
}

/** Line of three player troops plus one enemy in shoot range. */
function lineWithFoe(sim, gaps) {
  const a = spawn(sim, "player", "regulars", "top", {
    progress: 0.4,
    sublane: 1,
    order: "halt",
  });
  const b = spawn(sim, "player", "regulars", "top", {
    progress: 0.4,
    sublane: 2,
    order: "halt",
  });
  const c = spawn(sim, "player", "regulars", "top", {
    progress: 0.4,
    sublane: 3,
    order: "halt",
  });
  placeGap(b, a, gaps.left);
  placeGap(b, c, gaps.right);
  spawn(sim, "enemy", "regulars", "top", {
    progress: 0.55,
    sublane: 2,
    order: "halt",
  });
  return { a, b, c, allies: [a, b, c] };
}

describe("line damage bonus quality", () => {
  it("gives full stacked bonus when neighbors are Perfect Line", () => {
    const sim = makeSim();
    const { b, allies } = lineWithFoe(sim, { left: 0, right: 0 });
    assert.ok(b.lineOverlapRatio(allies[0]) === 1);
    assert.ok(b.lineOverlapRatio(allies[2]) === 1);
    assert.equal(b.lineDamagePercent(allies), 2 * CONFIG.troopLineBonus);
  });

  it("scales the stacked bonus by average neighbor overlap", () => {
    const sim = makeSim();
    // Midpoint between Perfect (2 paces) and In Line edge (16 paces) → 0.5.
    const mid = (CONFIG.perfectLinePaces * 2 + CONFIG.inLinePaces * 2) / 2;
    const { b, allies } = lineWithFoe(sim, { left: 0, right: mid });
    const leftQ = b.lineOverlapRatio(allies[0]);
    const rightQ = b.lineOverlapRatio(allies[2]);
    assert.ok(Math.abs(leftQ - 1) < 1e-9);
    assert.ok(Math.abs(rightQ - 0.5) < 1e-6);
    const expected = 2 * CONFIG.troopLineBonus * ((leftQ + rightQ) / 2);
    assert.ok(Math.abs(b.lineDamagePercent(allies) - expected) < 1e-6);
  });

  it("approaches zero when neighbors are almost out of In Line", () => {
    const sim = makeSim();
    const almostOut = CONFIG.inLinePaces * 2 - 0.5;
    const { b, allies } = lineWithFoe(sim, { left: almostOut, right: almostOut });
    const q = b.lineNeighborQuality(b.lineGroup(allies));
    assert.ok(q > 0 && q < 0.1, `expected near-zero quality, got ${q}`);
    const bonus = b.lineDamagePercent(allies);
    assert.ok(bonus > 0 && bonus < 2 * CONFIG.troopLineBonus * 0.1);
  });

  it("end units average only their one neighbor", () => {
    const sim = makeSim();
    const mid = (CONFIG.perfectLinePaces * 2 + CONFIG.inLinePaces * 2) / 2;
    const { a, allies } = lineWithFoe(sim, { left: mid, right: 0 });
    // a is left end: only neighbor is b at mid quality; c is not adjacent to a.
    const q = a.lineNeighborQuality(a.lineGroup(allies));
    assert.ok(Math.abs(q - 0.5) < 1e-6);
    assert.ok(Math.abs(a.lineDamagePercent(allies) - 2 * CONFIG.troopLineBonus * 0.5) < 1e-6);
  });

  it("recalculates line bonus on impact after the line is shoved", () => {
    const sim = makeSim();
    const mid = (CONFIG.perfectLinePaces * 2 + CONFIG.inLinePaces * 2) / 2;
    const { b, c, allies } = lineWithFoe(sim, { left: 0, right: 0 });
    const foe = sim.enemy.troops[0];
    const projectiles = [];
    b.fire(foe, allies, projectiles, "shoot");
    assert.equal(projectiles.length, 1);
    const shot = projectiles[0];
    const perfectLine = b.lineDamagePercent(allies);
    assert.equal(perfectLine, 2 * CONFIG.troopLineBonus);
    assert.ok(Math.abs(shot.impactAttackerSum() - (shot.attackerSum + perfectLine)) < 1e-6);
    placeGap(b, c, mid);
    const live = b.lineDamagePercent(allies);
    assert.ok(live < perfectLine);
    assert.ok(Math.abs(shot.impactAttackerSum() - (shot.attackerSum + live)) < 1e-6);
  });

  it("applies pending pushback before shooting so line quality is current", () => {
    const sim = makeSim();
    // Sit on the Perfect Line edge behind the shooter; shove moves further back.
    const edge = CONFIG.perfectLinePaces * 2;
    const { b, c, allies } = lineWithFoe(sim, { left: 0, right: -edge });
    assert.ok(b.lineOverlapRatio(c) >= 1 - 1e-9);
    const before = b.lineOverlapRatio(c);
    c.applyPushback(CONFIG.pushbackPerPace, true);
    c.pushbackAppliedThisTick = false;
    c.tickPushback(0, allies);
    assert.ok(b.lineOverlapRatio(c) < before);
    assert.ok(b.lineNeighborQuality(b.lineGroup(allies)) < 1);
  });
});
