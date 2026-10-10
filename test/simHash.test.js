import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { makeSim } from "./helpers.js";

/**
 * Locked before per-step indexes. A combat/movement change that is
 * unintentional will fail this. Update the digest only on purpose.
 */
const EXPECTED = "b2deb94cd6825dd95bba8bf4ff41793ca4641b0d";

function installRng() {
  let seed = 1;
  const original = Math.random;
  Math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return () => {
    Math.random = original;
  };
}

function digest(sim) {
  const parts = [];
  const sides = [sim.player, sim.enemy];
  for (let s = 0; s < sides.length; s += 1) {
    const side = sides[s];
    parts.push(`${side.id}:${Math.round(side.keepHP)}:${Math.round(side.gold)}`);
    const troops = side.troops.filter((troop) => troop.hp > 0);
    for (let i = 0; i < troops.length; i += 1) {
      const troop = troops[i];
      parts.push([
        troop.id,
        troop.type,
        troop.lane,
        troop.sublane,
        troop.order,
        Math.round(troop.hp * 1000),
        Math.round(troop.progress * 100000),
      ].join(","));
    }
  }
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

function crowd() {
  const sim = makeSim({ mapId: "empty", fogEnabled: false });
  sim.player.gold = 50000;
  sim.enemy.gold = 50000;
  const buys = [
    ["player", "top", "regulars"],
    ["player", "top", "regulars"],
    ["player", "top", "light"],
    ["player", "top", "major"],
    ["player", "bottom", "regulars"],
    ["player", "bottom", "regulars"],
    ["enemy", "top", "regulars"],
    ["enemy", "top", "regulars"],
    ["enemy", "top", "light"],
    ["enemy", "bottom", "regulars"],
    ["enemy", "bottom", "major"],
  ];
  for (let i = 0; i < buys.length; i += 1) {
    const [side, lane, unit] = buys[i];
    assert.equal(sim.applyCommand(side, { type: "buy", lane, unit }), true);
  }
  sim.applyCommand("player", { type: "order", troopId: 1, action: "forward" });
  sim.applyCommand("enemy", { type: "order", troopId: 7, action: "charge" });
  for (let i = 0; i < 80; i += 1) {
    sim.beginStep(0.05);
    if (i === 20) sim.applyCommand("player", { type: "order", troopId: 2, action: "forward" });
    sim.finishStep(0.05);
  }
  return digest(sim);
}

test("crowded match digest stays stable", () => {
  const restore = installRng();
  try {
    const hash = crowd();
    if (!EXPECTED) {
      assert.equal(typeof hash, "string");
      assert.equal(hash.length, 40);
      return;
    }
    assert.equal(hash, EXPECTED);
  } finally {
    restore();
  }
});
