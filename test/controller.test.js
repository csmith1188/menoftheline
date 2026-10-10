import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeBot, makeSim, quiet, spawn, stepBot } from "./helpers.js";

describe("decision clock and command ownership", () => {
  it("does not act again before the think interval", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const front = spawn(sim, "player", "regulars", "top", { progress: 0.3, sublane: 0 });
    spawn(sim, "player", "regulars", "top", { progress: 0.2, sublane: 1 });
    quiet(sim.player);
    let calls = 0;
    const apply = sim.applyCommand.bind(sim);
    sim.applyCommand = (sideId, cmd) => {
      calls += 1;
      return apply(sideId, cmd);
    };
    bot.act(sim);
    const first = calls;
    assert.equal(front.order, "halt");
    bot.act(sim);
    assert.equal(calls, first);
    assert.equal(front.order, "halt");
  });

  it("gives a forming troop one command, not a move as well", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const front = spawn(sim, "player", "regulars", "top", { progress: 0.3, sublane: 0 });
    spawn(sim, "player", "regulars", "top", { progress: 0.22, sublane: 1 });
    quiet(sim.player);
    const orders = [];
    const apply = sim.applyCommand.bind(sim);
    sim.applyCommand = (sideId, cmd) => {
      if (cmd.type === "order" && cmd.troopId === front.id) orders.push(cmd.action);
      return apply(sideId, cmd);
    };
    bot.act(sim);
    assert.deepEqual(orders, ["speedDown"]);
    assert.equal(front.order, "halt");
    assert.equal(front.switch, null);
  });

  it("drops locks for units that are gone", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const troop = spawn(sim, "player", "regulars", "top", { progress: 0.2, sublane: 0 });
    spawn(sim, "player", "regulars", "top", { progress: 0.2, sublane: 0 });
    quiet(sim.player);
    bot.act(sim);
    assert.ok(bot.locks.has(troop.id));
    troop.hp = 0;
    stepBot(bot, sim);
    assert.equal(bot.locks.has(troop.id), false);
  });
});
