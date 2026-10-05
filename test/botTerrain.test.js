import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { CONFIG } from "../shared/config.js";
import { terrainFootprintPaces } from "../shared/path.js";
import { clearTerrainCache, featuresOnMap } from "../shared/terrain.js";
import { assessBattlefield, localSituation } from "../server/bot/assess.js";
import { botProfile } from "../server/bot/controller.js";
import { decideIntents } from "../server/bot/tactics.js";
import { makeBot, makeSim, quiet, spawn } from "./helpers.js";

beforeEach(() => {
  clearTerrainCache();
});

function progressFromPlayerPaces(sideId, lane, paces) {
  const total = lane === "top" ? CONFIG.topLanePaces : CONFIG.bottomLanePaces;
  const t = paces / total;
  return sideId === "player" ? t : 1 - t;
}

function woodsFeature() {
  return featuresOnMap("default").find((f) => f.id === "woods-bottom-outer-a");
}

/**
 * Enemy inside woods revealed by melee; a second troop further back can
 * see them (fog) but cannot shoot into the woods until it occupies them.
 */
function setupWoodsLosBlock(sim) {
  const woods = woodsFeature();
  const half = terrainFootprintPaces();
  const grappler = spawn(sim, "player", "troop", "bottom", {
    progress: progressFromPlayerPaces("player", "bottom", woods.centerPaces - half - 2),
    sublane: 0,
    order: "halt",
  });
  const foe = spawn(sim, "enemy", "guerrilla", "bottom", {
    progress: progressFromPlayerPaces("enemy", "bottom", woods.centerPaces - half + 2),
    sublane: 0,
    order: "halt",
  });
  foe.progress = progressFromPlayerPaces("enemy", "bottom", woods.centerPaces - half + 2);
  foe.syncPosition();
  const shooter = spawn(sim, "player", "troop", "bottom", {
    progress: progressFromPlayerPaces("player", "bottom", woods.centerPaces - half - 80),
    sublane: 0,
    order: "halt",
  });
  return { grappler, shooter, foe, woods };
}

describe("bot terrain awareness", () => {
  it("marks a woods-hidden enemy as losBlocked for a shooter outside", () => {
    const sim = makeSim({ mapId: "default" });
    const { shooter } = setupWoodsLosBlock(sim);

    const profile = botProfile("simple");
    const snap = assessBattlefield(sim, "player", profile);
    const local = localSituation(shooter, snap.lanes.bottom, profile, {
      mapId: snap.mapId,
      sideId: snap.sideId,
      troopsBySide: snap.troopsBySide,
    });
    assert.ok(local.nearestEnemyPaces != null);
    assert.ok(local.nearestEnemyPaces <= shooter.rangePaces());
    assert.equal(local.shootableInRange, false);
    assert.equal(local.losBlocked, true);
  });

  it("advances to clear LOS instead of halting for an unshootable target", () => {
    const sim = makeSim({ mapId: "default" });
    const bot = makeBot("simple");
    const { shooter } = setupWoodsLosBlock(sim);
    quiet(sim.player);
    quiet(sim.enemy);

    const profile = botProfile("simple");
    const snap = assessBattlefield(sim, "player", profile);
    const decisions = decideIntents(bot, snap, profile);
    const decision = decisions.find((d) => d.unit === shooter);
    assert.ok(decision);
    assert.equal(decision.intent, "advance");
    assert.equal(decision.reason, "los");
  });

  it("reports a reduced moveFactor while standing in woods", () => {
    const sim = makeSim({ mapId: "default" });
    const woods = woodsFeature();
    const unit = spawn(sim, "player", "troop", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", woods.centerPaces),
      sublane: 0,
    });
    const profile = botProfile("simple");
    const snap = assessBattlefield(sim, "player", profile);
    const local = localSituation(unit, snap.lanes.bottom, profile, {
      mapId: snap.mapId,
      sideId: snap.sideId,
      troopsBySide: snap.troopsBySide,
    });
    assert.ok(local.moveFactor < 1);
    assert.equal(local.moveFactor, CONFIG.woodsSlow);
  });
});
