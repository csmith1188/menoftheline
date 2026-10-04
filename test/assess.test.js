import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG } from "../shared/config.js";
import {
  assessBattlefield,
  combatValue,
  keepThreatReach,
  localSituation,
  nextPosture,
} from "../server/bot/assess.js";
import { botProfile } from "../server/bot/controller.js";
import { makeSim, spawn } from "./helpers.js";

describe("battlefield assessment", () => {
  it("ignores an enemy outside the local radius", () => {
    const sim = makeSim();
    const friend = spawn(sim, "player", "troop", "top", { progress: 0.2, sublane: 2 });
    spawn(sim, "enemy", "troop", "top", { progress: 0.2, sublane: 2 });
    const snap = assessBattlefield(sim, "player", botProfile("simple"));
    const far = localSituation(friend, snap.lanes.top, botProfile("simple"));
    assert.equal(far.supportEnemy, 0);

    const nearEnemy = sim.enemy.troops[0];
    nearEnemy.progress = 0.75;
    nearEnemy.syncPosition();
    // Re-assess: fog visibility (and the filtered enemy list) is per snapshot.
    const snapNear = assessBattlefield(sim, "player", botProfile("simple"));
    const near = localSituation(friend, snapNear.lanes.top, botProfile("simple"));
    assert.ok(near.supportEnemy > 0);
  });

  it("strength falls with missing HP and, on Hard, with fatigue", () => {
    const sim = makeSim();
    const healthy = spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 1 });
    const wounded = spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 2, hp: 100 });
    const tired = spawn(sim, "player", "troop", "bottom", {
      progress: 0.4,
      sublane: 1,
      fatigue: 100,
    });
    const hard = botProfile("hard");
    const simple = botProfile("simple");
    const full = combatValue(healthy, hard, "support");
    assert.ok(combatValue(wounded, hard, "support") < full);
    assert.equal(combatValue(wounded, hard, "support"), full * 0.5);
    assert.ok(combatValue(tired, hard, "support") < full);
    assert.equal(combatValue(tired, simple, "support"), full);
  });

  it("a skirmisher on the rim is a smaller keep threat than two troops", () => {
    const sim = makeSim();
    const hard = botProfile("hard");
    const rimPaces = keepThreatReach() - 20;
    spawn(sim, "enemy", "skirmisher", "top", {
      progress: 1 - rimPaces / 1000,
      sublane: 2,
    });
    const rim = assessBattlefield(sim, "player", hard).lanes.top.threat;

    const close = makeSim();
    spawn(close, "enemy", "troop", "top", { progress: 0.98, sublane: 1 });
    spawn(close, "enemy", "troop", "top", { progress: 0.98, sublane: 2 });
    const mass = assessBattlefield(close, "player", hard).lanes.top.threat;

    assert.ok(mass > rim * 5);
    assert.ok(rim < CONFIG.botKeepThreatDefend);
    assert.ok(mass > CONFIG.botKeepThreatDefend);
  });

  it("posture leaves Defend only after the exit ratio", () => {
    const quiet = { share: 0.5, threat: 0 };
    assert.equal(nextPosture("hold", { ...quiet, advantage: 0.7 }), "defend");
    assert.equal(nextPosture("defend", { ...quiet, advantage: 0.85 }), "defend");
    assert.equal(nextPosture("defend", { ...quiet, advantage: 0.96 }), "hold");
  });
});
