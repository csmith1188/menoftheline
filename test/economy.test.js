import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG } from "../shared/config.js";
import { UNIT_STATS, categoryOf, unitIdOf, unitLandCost } from "../shared/units.js";
import { chooseSpawnKey, desiredComposition } from "../server/bot/economy.js";
import { botProfile } from "../server/bot/controller.js";
import { makeBot, makeSim, spawn, stepBot, living } from "./helpers.js";

function spawnCtx(overrides = {}) {
  return {
    laneUnits: [],
    allFriends: [],
    mods: {
      skirmisherFromCavalry: false,
      dragoonFromSupport: false,
      cannonFromInfantry: false,
      officerFromLine: false,
    },
    posture: "hold",
    enemyRows: 0,
    armyValue: 0,
    mapHasWoodsOrPeaks: false,
    mapHasRiverOrHill: false,
    frontSlowed: false,
    gunsBlocked: false,
    ...overrides,
  };
}

function valueOf(units, type) {
  return units
    .filter((unit) => unit.hp > 0 && (!type || categoryOf(unit) === type || unit.unit === type || unit.type === type))
    .reduce((sum, unit) => sum + UNIT_STATS[unitIdOf(unit)].cost, 0);
}

describe("purchases", () => {
  it("Simple stays near the configured composition", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    sim.player.gold = 20000;
    sim.player.land = 0;
    sim.player.income = 1000;
    for (let i = 0; i < 24; i += 1) stepBot(bot, sim);
    const units = living(sim.player);
    const total = valueOf(units);
    assert.ok(total > 1500);
    for (const type of Object.keys(CONFIG.botComposition)) {
      const fraction = valueOf(units, type) / total;
      assert.ok(
        Math.abs(fraction - CONFIG.botComposition[type]) < 0.16,
        `${type} fraction ${fraction.toFixed(2)}`,
      );
    }
  });

  it("buys skirmishers before field guns early", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    sim.player.gold = 900;
    sim.player.land = 0;
    sim.player.income = 1000;
    for (let i = 0; i < 8; i += 1) stepBot(bot, sim);
    const units = living(sim.player);
    assert.ok(valueOf(units) <= CONFIG.botCannonArmyValue);
    assert.equal(living(sim.player, "fieldGun").length, 0);
    assert.ok(living(sim.player, "light").length >= 1);
  });

  it("Hard buys a skirmisher against a dragoon and then stops", () => {
    const sim = makeSim();
    const bot = makeBot("hard");
    for (let i = 0; i < 6; i += 1) {
      spawn(sim, "player", "regulars", "bottom", { progress: 0.3, sublane: i % 3 });
    }
    spawn(sim, "enemy", "dragoon", "bottom", { progress: 0.55, sublane: 1 });
    sim.player.gold = 20000;
    sim.player.land = 0;
    sim.player.income = 1000;
    for (let i = 0; i < 14; i += 1) stepBot(bot, sim);
    const units = living(sim.player);
    const desired = desiredComposition(
      botProfile("hard"),
      units,
      living(sim.enemy),
    ).desired.skirmishers;
    const fraction = valueOf(units, "skirmishers") / valueOf(units);
    assert.ok(living(sim.player, "light").length >= 1);
    assert.ok(fraction <= desired + 0.1, `skirmisher fraction ${fraction} vs ${desired}`);
    assert.ok(living(sim.player, "fieldGun").length + living(sim.player, "dragoon").length > 0);
    const before = fraction;
    for (let i = 0; i < 8; i += 1) stepBot(bot, sim);
    const later = living(sim.player);
    const laterFraction = valueOf(later, "skirmishers") / valueOf(later);
    assert.ok(laterFraction <= desired + 0.1);
    assert.ok(laterFraction <= before + 0.08);
  });

  it("sends a unit to a keep threat instead of a mildly losing lane", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    spawn(sim, "player", "regulars", "top", { progress: 0.2, sublane: 2 });
    spawn(sim, "enemy", "regulars", "top", { progress: 0.3, sublane: 2 });
    spawn(sim, "enemy", "regulars", "bottom", { progress: 0.98, sublane: 0 });
    spawn(sim, "enemy", "regulars", "bottom", { progress: 0.98, sublane: 1 });
    sim.checkpoints[0].owner = "player";
    sim.checkpoints[0].producing = false;
    sim.player.land = 400;
    sim.player.gold = 200;
    sim.player.income = 1000;
    const before = living(sim.player).length;
    stepBot(bot, sim);
    const bought = living(sim.player).filter((unit) => unit.lane === "bottom");
    assert.equal(living(sim.player).length, before + 1);
    assert.equal(bought.length, 1);
    assert.equal(sim.checkpoints[0].producing, false);
    assert.equal(bot.lanePosture.bottom, "defend");
  });

  it("opens on the top lane, then seeds the bottom", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    sim.player.gold = 600;
    sim.player.land = 0;
    sim.player.income = 1000;
    for (let i = 0; i < 6; i += 1) stepBot(bot, sim);
    const top = living(sim.player).filter((unit) => unit.lane === "top");
    const bottom = living(sim.player).filter((unit) => unit.lane === "bottom");
    assert.ok(top.length >= CONFIG.botTopGarrison);
    assert.ok(bottom.length <= CONFIG.botBottomSeed);
    assert.ok(top.length > bottom.length);
  });

  it("seeds the bottom lane once the top garrison is standing", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    for (let i = 0; i < CONFIG.botTopGarrison; i += 1) {
      spawn(sim, "player", "regulars", "top", { progress: 0.2, sublane: i });
    }
    sim.player.gold = 200;
    sim.player.land = 0;
    sim.player.income = 1000;
    stepBot(bot, sim);
    const bottoms = living(sim.player).filter((unit) => unit.lane === "bottom");
    assert.equal(bottoms.length, 1);
    assert.equal(bottoms[0].unit, "regulars");
  });

  it("reinforces the top lane when the enemy is ahead there", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    for (let i = 0; i < CONFIG.botTopGarrison; i += 1) {
      spawn(sim, "player", "regulars", "top", { progress: 0.3, sublane: i });
    }
    for (let i = 0; i < CONFIG.botBottomSeed; i += 1) {
      spawn(sim, "player", "regulars", "bottom", { progress: 0.1, sublane: i });
    }
    for (let i = 0; i < CONFIG.botTopGarrison + 2; i += 1) {
      spawn(sim, "enemy", "regulars", "top", { progress: 0.35, sublane: i % 5 });
    }
    bot.buyLane = "bottom";
    sim.player.gold = 200;
    sim.player.land = 0;
    sim.player.income = 1000;
    const before = living(sim.player).filter((unit) => unit.lane === "top").length;
    stepBot(bot, sim);
    const after = living(sim.player).filter((unit) => unit.lane === "top").length;
    assert.equal(after, before + 1);
  });

  it("buys a bank when upkeep eats income", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    for (let i = 0; i < 12; i += 1) {
      spawn(sim, "player", "fieldGun", "top", { progress: 0.1, sublane: i % 5 });
    }
    sim.player.gold = 240;
    sim.player.land = 0;
    stepBot(bot, sim);
    assert.equal(sim.player.banks, 1);
    assert.equal(living(sim.player, "fieldGun").length, 12);
  });

  it("banks after a desperate buy fails when upkeep is already too high", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    spawn(sim, "player", "regulars", "top", { progress: 0.1, sublane: 0 });
    const saved = {};
    for (const key of ["regulars", "light", "dragoon", "fieldGun", "major"]) {
      saved[key] = UNIT_STATS[key].cost;
      UNIT_STATS[key].cost = 5000;
    }
    try {
      sim.player.keepHP = CONFIG.keepHP * 0.2;
      sim.player.gold = 240;
      sim.player.income = 0;
      sim.player.land = 0;
      stepBot(bot, sim);
      assert.equal(sim.player.banks, 1);
    } finally {
      for (const key of Object.keys(saved)) UNIT_STATS[key].cost = saved[key];
    }
  });

  it("turns a town on once the lane has infantry", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    for (let i = 0; i < 3; i += 1) {
      spawn(sim, "player", "regulars", "bottom", { progress: 0.2, sublane: i });
      spawn(sim, "player", "regulars", "top", { progress: 0.2, sublane: i });
    }
    sim.checkpoints[0].owner = "player";
    sim.checkpoints[0].producing = false;
    sim.player.gold = 500;
    sim.player.land = 200;
    sim.player.income = 1000;
    const before = living(sim.player).length;
    stepBot(bot, sim);
    assert.equal(sim.checkpoints[0].producing, true);
    assert.equal(living(sim.player).length, before);
  });

  it("Simple buys a light militia when gold cannot cover a troop", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    // Under the line minimum so decideEconomy forces a troop-role buy.
    spawn(sim, "player", "regulars", "top", { progress: 0.25, sublane: 0 });
    spawn(sim, "player", "regulars", "top", { progress: 0.25, sublane: 1 });
    bot.buyLane = "top";
    sim.player.gold = UNIT_STATS.militia.cost + 20;
    sim.player.land = unitLandCost("militia") + CONFIG.upgradeBaseCost;
    sim.player.income = 1000;
    assert.ok(sim.player.gold < UNIT_STATS.regulars.cost);
    const before = living(sim.player).length;
    stepBot(bot, sim);
    const militia = living(sim.player).filter((unit) => unit.variant === "militia");
    assert.equal(living(sim.player).length, before + 1);
    assert.equal(militia.length, 1);
  });

  it("Hard picks grenadiers when attacking with a formed line", () => {
    const sim = makeSim();
    const troops = [];
    for (let i = 0; i < CONFIG.botMinTroopsBeforeSupport; i += 1) {
      troops.push(spawn(sim, "player", "regulars", "top", { progress: 0.25, sublane: i }));
    }
    sim.player.gold = UNIT_STATS.grenadier.cost + 50;
    sim.player.land = unitLandCost("grenadier") + CONFIG.upgradeBaseCost;
    const key = chooseSpawnKey(sim.player, "regulars", botProfile("hard"), spawnCtx({
      laneUnits: troops,
      allFriends: troops,
      posture: "attack",
      armyValue: valueOf(troops),
    }));
    assert.equal(key, "grenadier");
  });

  it("picks light militia on hold once a line exists", () => {
    const sim = makeSim();
    const troops = [];
    for (let i = 0; i < CONFIG.botMinTroopsBeforeSupport; i += 1) {
      troops.push(spawn(sim, "player", "regulars", "top", { progress: 0.25, sublane: i }));
    }
    sim.player.gold = UNIT_STATS.regulars.cost + 50;
    sim.player.land = unitLandCost("militia") + CONFIG.upgradeBaseCost;
    const key = chooseSpawnKey(sim.player, "regulars", botProfile("simple"), spawnCtx({
      laneUnits: troops,
      allFriends: troops,
      posture: "hold",
      armyValue: valueOf(troops),
    }));
    assert.equal(key, "militia");
  });
});
