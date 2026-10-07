import { GameSim } from "../server/sim.js";
import { unitLandCost, unitStats } from "../shared/units.js";
import { BotController } from "../server/bot.js";

/** Fresh sim. Defaults to the empty map so combat tests ignore terrain LOS. */
export function makeSim(opts = {}) {
  const sim = new GameSim();
  sim.applyMatchOptions({
    mapId: opts.mapId || "empty",
    fortsEnabled: opts.fortsEnabled,
    fogEnabled: opts.fogEnabled,
    baseGps: opts.baseGps,
  });
  return sim;
}

export function makeBot(difficulty = "simple", sideId = "player") {
  return new BotController(sideId, { difficulty });
}

/** Spawn through the real buy path, then place the body. */
export function spawn(sim, sideId, type, lane, opts = {}) {
  const side = sim.side(sideId);
  side.gold += unitStats(type).cost;
  side.land += unitLandCost(type);
  const unit = sim.grantTroop(side, lane, type);
  if (!unit) throw new Error(`spawn failed for ${type}`);
  if (opts.sublane != null && opts.sublane !== unit.sublane) {
    unit.sublane = opts.sublane;
    unit.applyPath();
  }
  if (opts.progress != null) unit.progress = opts.progress;
  unit.syncPosition();
  if (opts.hp != null) unit.hp = opts.hp;
  if (opts.fatigue != null) unit.fatigue = opts.fatigue;
  if (opts.broken) unit.broken = true;
  if (opts.order !== undefined) unit.order = opts.order;
  return unit;
}

/** Stop the bot from spending during an orders test. */
export function quiet(side) {
  side.gold = 0;
  side.land = 0;
  side.income = 1000;
}

/** Run one think, advancing the clock if the previous one is still in effect. */
export function stepBot(bot, sim) {
  if (sim.elapsed < bot.nextThinkAt) sim.elapsed = bot.nextThinkAt;
  bot.act(sim);
}

export function living(side, type) {
  return side.troops.filter((unit) => unit.hp > 0 && (!type || unit.type === type));
}
