import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG } from "../shared/config.js";
import {
  assessBattlefield,
  localSituation,
} from "../server/bot/assess.js";
import { botProfile } from "../server/bot/controller.js";
import { makeBot, makeSim, quiet, spawn, stepBot } from "./helpers.js";

function placeLine(sim, count, progress, order) {
  const units = [];
  for (let i = 0; i < count; i += 1) {
    units.push(spawn(sim, "player", "troop", "top", {
      progress,
      sublane: i,
      order,
    }));
  }
  return units;
}

describe("hysteresis, keeps, and defense", () => {
  it("does not resume an advance while the local ratio is still short of even", () => {
    const sim = makeSim();
    const bot = makeBot("hard");
    const friend = spawn(sim, "player", "troop", "top", { progress: 0.5, sublane: 2 });
    const foe = spawn(sim, "enemy", "troop", "top", { progress: 0.4, sublane: 0 });
    const hard = botProfile("hard");
    const tune = (hp) => {
      friend.hp = hp;
      const snap = assessBattlefield(sim, "player", hard);
      return localSituation(friend, snap.lanes.top, hard).supportRatio;
    };
    let low = 200;
    while (tune(low) >= CONFIG.botRetreatRatio) low -= 1;
    friend.hp = low;
    quiet(sim.player);
    quiet(sim.enemy);
    stepBot(bot, sim);
    assert.equal(friend.order, "fallback");

    let mid = low;
    while (tune(mid) < 0.85) mid += 1;
    friend.hp = mid;
    stepBot(bot, sim);
    assert.equal(friend.order, "fallback");
    void foe;
  });

  it("does not flip a cannon between halt and advance inside the dead band", () => {
    const range = spawn(makeSim(), "player", "cannon", "top", { progress: 0 }).rangePaces();
    const inner = range * CONFIG.botCannonHaltBand;
    const outer = range * CONFIG.botCannonAdvanceBand;
    const gap = (inner + outer) / 2;

    const held = makeSim();
    const botHeld = makeBot("hard");
    const gun = spawn(held, "player", "cannon", "top", { progress: 0.2, sublane: 2 });
    const foe = spawn(held, "enemy", "troop", "top", {
      progress: 1 - (0.2 + inner * 0.6 / 1000),
      sublane: 0,
    });
    quiet(held.player);
    quiet(held.enemy);
    stepBot(botHeld, held);
    assert.equal(gun.order, "halt");
    foe.progress = 1 - (gun.progress + gap / 1000);
    foe.syncPosition();
    stepBot(botHeld, held);
    assert.equal(gun.order, "halt");

    const moving = makeSim();
    const botMove = makeBot("hard");
    const walker = spawn(moving, "player", "cannon", "top", { progress: 0.2, sublane: 2 });
    const far = spawn(moving, "enemy", "troop", "top", {
      progress: 1 - (0.2 + (outer + 80) / 1000),
      sublane: 0,
    });
    quiet(moving.player);
    quiet(moving.enemy);
    stepBot(botMove, moving);
    assert.equal(walker.order, null);
    far.progress = 1 - (walker.progress + gap);
    far.syncPosition();
    stepBot(botMove, moving);
    assert.equal(walker.order, null);
  });

  it("commits a stacked force beside the enemy keep and will not send one troop", () => {
    const committed = makeSim();
    const bot = makeBot("hard");
    const line = placeLine(committed, 5, 0.86, "halt");
    spawn(committed, "enemy", "troop", "top", { progress: 0.04, sublane: 2 });
    quiet(committed.player);
    quiet(committed.enemy);
    stepBot(bot, committed);
    assert.equal(bot.laneCommit.top, "keepAttack");
    assert.equal(line[0].order, null);

    const lone = makeSim();
    const botLone = makeBot("hard");
    const one = spawn(lone, "player", "troop", "top", {
      progress: 0.86, sublane: 2, order: "halt",
    });
    spawn(lone, "enemy", "troop", "top", { progress: 0.04, sublane: 1 });
    quiet(lone.player);
    quiet(lone.enemy);
    stepBot(botLone, lone);
    assert.equal(botLone.laneCommit.top, null);
    assert.equal(one.order, "halt");
  });

  it("defends a lane whose keep is actually threatened", () => {
    const sim = makeSim();
    const bot = makeBot("hard");
    spawn(sim, "player", "troop", "top", { progress: 0.25, sublane: 2 });
    spawn(sim, "enemy", "troop", "bottom", { progress: 0.98, sublane: 0 });
    spawn(sim, "enemy", "troop", "bottom", { progress: 0.98, sublane: 1 });
    sim.player.gold = 150;
    sim.player.income = 1000;
    sim.player.land = 0;
    stepBot(bot, sim);
    assert.equal(bot.lanePosture.bottom, "defend");
    const bought = sim.player.troops.filter((unit) => unit.lane === "bottom" && unit.type === "troop");
    assert.equal(bought.length, 1);
  });
});
