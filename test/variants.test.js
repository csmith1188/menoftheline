import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { CONFIG } from "../shared/config.js";
import {
  cycleVariantPick,
  mobilityClass,
  unitLandCost,
  unitStats,
  variantBadgeFill,
  variantOptions,
} from "../shared/units.js";
import {
  auraOverlapsFeature,
  canOccupy,
  clearTerrainCache,
  engineerAuraPaces,
  featuresOnMap,
  hasShotLos,
  isEnemyVisible,
  moveSpeedFactor,
  shootRangeFactor,
  unitOnClosedRiver,
} from "../shared/terrain.js";
import { makeSim, spawn } from "./helpers.js";

beforeEach(() => {
  clearTerrainCache();
});

function progressFromPlayerPaces(sideId, lane, paces) {
  const total = lane === "top" ? CONFIG.topLanePaces : CONFIG.bottomLanePaces;
  const t = paces / total;
  return sideId === "player" ? t : 1 - t;
}

function troopsBySide(sim) {
  return { player: sim.player.troops, enemy: sim.enemy.troops };
}

function step(sim, dt = 0.05, n = 8) {
  for (let i = 0; i < n; i += 1) {
    sim.beginStep(dt);
    sim.finishStep(dt);
  }
}

describe("alternate catalog", () => {
  it("cycles base → yellow elite → white light", () => {
    const opts = variantOptions("troop");
    assert.deepEqual(opts, ["troop", "grenadier", "militia"]);
    assert.equal(cycleVariantPick("troop", "troop", 1), "grenadier");
    assert.equal(cycleVariantPick("troop", "grenadier", 1), "militia");
    assert.equal(cycleVariantPick("troop", "militia", 1), "troop");
    assert.equal(cycleVariantPick("troop", "troop", -1), "militia");
    assert.equal(variantBadgeFill("grenadier"), CONFIG.colors.yellowAlternate);
    assert.equal(variantBadgeFill("militia"), CONFIG.colors.whiteAlternate);
    assert.equal(variantBadgeFill("troop"), null);
  });

  it("charges elite land at the elite ratio and light at the light ratio", () => {
    assert.equal(unitLandCost("grenadier"), Math.round(unitStats("grenadier").cost * CONFIG.unitLandCostRatio));
    assert.equal(unitLandCost("militia"), Math.round(unitStats("militia").cost * CONFIG.lightUnitLandCostRatio));
    assert.equal(unitLandCost("troop"), 0);
    assert.equal(mobilityClass("horseGun"), "artillery");
    assert.equal(mobilityClass("hussar"), "cavalry");
  });
});

describe("militia", () => {
  it("lines with troops and keeps the troop line bonus", () => {
    const sim = makeSim();
    const a = spawn(sim, "player", "militia", "top", { progress: 0.4, sublane: 1, order: "halt" });
    const b = spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 2, order: "halt" });
    spawn(sim, "enemy", "troop", "top", { progress: 0.55, sublane: 2, order: "halt" });
    assert.equal(a.type, "troop");
    assert.equal(a.variant, "militia");
    const line = a.lineGroup(sim.player.troops);
    assert.ok(line.includes(b));
    assert.ok(a.lineDamagePercent(sim.player.troops) > 0);
  });
});

describe("guerrilla stealth", () => {
  it("hides at range, reveals within 50 paces, and reveals after a shot", () => {
    const sim = makeSim();
    spawn(sim, "player", "troop", "top", { progress: 0.1, sublane: 2, order: "halt" });
    const guerilla = spawn(sim, "enemy", "guerrilla", "top", {
      progress: 0.2,
      sublane: 2,
      order: "halt",
    });
    const tb = troopsBySide(sim);
    assert.equal(isEnemyVisible("player", guerilla, tb), false);

    const near = spawn(sim, "player", "troop", "top", { progress: 0.78, sublane: 2, order: "halt" });
    assert.equal(isEnemyVisible("player", guerilla, troopsBySide(sim)), true);

    near.hp = 0;
    assert.equal(isEnemyVisible("player", guerilla, troopsBySide(sim)), false);
    guerilla.lastShotAt = sim.elapsed;
    assert.equal(isEnemyVisible("player", guerilla, troopsBySide(sim)), true);
    sim.elapsed += CONFIG.guerrillaShotRevealSec + 0.05;
    assert.equal(isEnemyVisible("player", guerilla, troopsBySide(sim)), false);
  });

  it("cannot be seen or shot outside stealth range unless they just fired", () => {
    const sim = makeSim();
    const watcher = spawn(sim, "player", "troop", "top", {
      progress: 0.35,
      sublane: 2,
      order: "halt",
    });
    const guerilla = spawn(sim, "enemy", "guerrilla", "top", {
      progress: progressFromPlayerPaces("enemy", "top", 500),
      sublane: 2,
      order: "halt",
    });
    const tb = troopsBySide(sim);
    assert.equal(isEnemyVisible("player", guerilla, tb), false);
    assert.equal(watcher.inShotRange(guerilla, watcher.shootRange()), false);
    assert.equal(
      watcher.nearestTarget(sim.enemy.troops, watcher.shootRange(), sim.player.troops, sim.enemy),
      null,
    );
    assert.equal(sim.snapshot({ forSideId: "player" }).sides.enemy.troops.length, 0);

    guerilla.lastShotAt = sim.elapsed;
    assert.equal(isEnemyVisible("player", guerilla, troopsBySide(sim)), true);
    assert.equal(watcher.inShotRange(guerilla, watcher.shootRange()), true);
  });

  it("does not volley while Halted in the open except inside stealth range, but does from terrain and while Advancing", () => {
    const open = makeSim();
    const openG = spawn(open, "player", "guerrilla", "top", {
      progress: 0.35,
      sublane: 2,
      order: "halt",
    });
    spawn(open, "enemy", "troop", "top", {
      progress: progressFromPlayerPaces("enemy", "top", 430),
      sublane: 2,
      order: "halt",
    });
    const openAllies = open.player.troops;
    const openEnemies = open.enemy.troops;
    assert.equal(openG.mayShoot(openAllies, openEnemies, open.enemy), false);
    const blocked = [];
    openG.fire(openEnemies[0], openAllies, blocked, "shoot");
    assert.equal(blocked.length, 0);

    openEnemies[0].progress = progressFromPlayerPaces("enemy", "top", 350 + CONFIG.guerrillaStealthPaces - 5);
    openEnemies[0].syncPosition();
    assert.equal(openG.mayShoot(openAllies, openEnemies, open.enemy), true);

    openG.order = null;
    openEnemies[0].progress = progressFromPlayerPaces("enemy", "top", 430);
    openEnemies[0].syncPosition();
    assert.equal(openG.mayShoot(openAllies, openEnemies, open.enemy), true);

    const sim = makeSim({ mapId: "default" });
    const woods = featuresOnMap("default").find((f) => f.id === "woods-bottom-outer-a");
    const hidden = spawn(sim, "player", "guerrilla", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", woods.centerPaces),
      sublane: woods.sublanes[0],
      order: "halt",
    });
    const ahead = woods.centerPaces + woods.halfWidthPaces + 40;
    spawn(sim, "enemy", "troop", "bottom", {
      progress: progressFromPlayerPaces("enemy", "bottom", ahead),
      sublane: woods.sublanes[0],
      order: "halt",
    });
    assert.equal(hidden.mayShoot(sim.player.troops, sim.enemy.troops, sim.enemy), true);
  });
});

describe("Hussar", () => {
  it("is not slowed by woods and is blocked by peaks", () => {
    const sim = makeSim({ mapId: "default" });
    const woods = featuresOnMap("default").find((f) => f.id === "woods-bottom-outer-a");
    const horse = spawn(sim, "player", "hussar", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", woods.centerPaces),
      sublane: 0,
    });
    assert.equal(moveSpeedFactor(horse), 1);
    const peak = featuresOnMap("default").find((f) => f.id === "peak-bottom-inner-a");
    assert.equal(canOccupy("hussar", "bottom", 2, peak.centerPaces), false);
  });

  it("gets pack bonus from other Hussar in melee reach, not Dragoons", () => {
    const sim = makeSim();
    const lc = spawn(sim, "player", "hussar", "top", {
      progress: 0.5,
      sublane: 1,
      order: "charge",
    });
    spawn(sim, "player", "dragoon", "top", { progress: 0.5, sublane: 2, order: "charge" });
    assert.equal(lc.packDamagePercent(sim.player.troops), 0);
    spawn(sim, "player", "hussar", "top", { progress: 0.5, sublane: 2, order: "charge" });
    assert.ok(lc.packDamagePercent(sim.player.troops) >= CONFIG.cavalryPackBonus - 1e-9);
  });
});

describe("horse guns", () => {
  it("uses horse-gun stats and artillery river block", () => {
    const sim = makeSim({ mapId: "default" });
    const gun = spawn(sim, "player", "horseGun", "top", { progress: 0.2, sublane: 2 });
    assert.equal(gun.type, "cannon");
    assert.equal(gun.speed, 20);
    assert.equal(gun.range, 250);
    assert.equal(gun.rangedDamage, 90);
    assert.equal(gun.chargeSpeed, 1);
    const river = featuresOnMap("default").find((f) => f.id === "river-bottom-outer");
    assert.equal(canOccupy("horseGun", "bottom", 0, river.centerPaces), false);
  });
});

describe("engineer", () => {
  it("does not restore friends", () => {
    const sim = makeSim();
    const ally = spawn(sim, "player", "troop", "top", { progress: 0.5, sublane: 2 });
    spawn(sim, "player", "engineer", "top", { progress: 0.5, sublane: 1 });
    ally.hp = 40;
    ally.fatigue = 40;
    sim.applySupport(sim.player, 1);
    assert.equal(ally.hp, 40);
  });

  it("unblocks LOS through a nearby unoccupied hill", () => {
    const sim = makeSim({ mapId: "default" });
    const hill = featuresOnMap("default").find((f) => f.id === "hill-top-nw");
    const observer = spawn(sim, "player", "troop", "top", {
      progress: progressFromPlayerPaces("player", "top", hill.centerPaces - 80),
      sublane: 0,
      order: "halt",
    });
    const target = spawn(sim, "enemy", "troop", "top", {
      progress: progressFromPlayerPaces("enemy", "top", hill.centerPaces + 80),
      sublane: 0,
      order: "halt",
    });
    const tb = troopsBySide(sim);
    assert.equal(hasShotLos(observer, target, "player", tb), false);
    spawn(sim, "player", "engineer", "top", {
      progress: progressFromPlayerPaces("player", "top", hill.centerPaces - 40),
      sublane: 2,
    });
    sim.syncTerrainFx();
    assert.equal(hasShotLos(observer, target, "player", troopsBySide(sim)), true);
  });

  it("pontoons a river for artillery and peels guns when the pontoon drops", () => {
    const sim = makeSim({ mapId: "default" });
    const river = featuresOnMap("default").find((f) => f.id === "river-bottom-outer");
    assert.equal(canOccupy("cannon", "bottom", 0, river.centerPaces), false);
    const eng = spawn(sim, "player", "engineer", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", river.centerPaces - 10),
      sublane: 1,
    });
    sim.syncTerrainFx();
    assert.equal(canOccupy("cannon", "bottom", 0, river.centerPaces), true);
    const gun = spawn(sim, "player", "cannon", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", river.centerPaces),
      sublane: 0,
      order: "halt",
    });
    assert.equal(unitOnClosedRiver(gun), false);
    eng.hp = 0;
    sim.syncTerrainFx();
    assert.equal(unitOnClosedRiver(gun), true);
    const before = gun.progress;
    step(sim, 0.1, 6);
    assert.ok(gun.progress < before);
  });

  it("shares a hill range bonus with friends in aura", () => {
    const sim = makeSim({ mapId: "default" });
    const hill = featuresOnMap("default").find((f) => f.id === "hill-top-nw");
    spawn(sim, "player", "engineer", "top", {
      progress: progressFromPlayerPaces("player", "top", hill.centerPaces),
      sublane: 0,
    });
    const friend = spawn(sim, "player", "troop", "top", {
      progress: progressFromPlayerPaces("player", "top", hill.centerPaces + 40),
      sublane: 2,
    });
    assert.equal(shootRangeFactor(friend), 1 + CONFIG.hillRangeBonus);
  });

  it("doubles officer aura on a hill or peak", () => {
    const sim = makeSim({ mapId: "default" });
    const hill = featuresOnMap("default").find((f) => f.id === "hill-top-nw");
    const peak = featuresOnMap("default").find((f) => f.id === "peak-bottom-inner-a");
    const woods = featuresOnMap("default").find((f) => f.id === "woods-bottom-ab");
    const onHill = spawn(sim, "player", "engineer", "top", {
      progress: progressFromPlayerPaces("player", "top", hill.centerPaces),
      sublane: 0,
    });
    const onPeak = spawn(sim, "player", "engineer", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", peak.centerPaces),
      sublane: peak.sublanes[0],
    });
    const plain = spawn(sim, "player", "engineer", "top", {
      progress: 0.5,
      sublane: 2,
    });
    const doubled = CONFIG.officerRestorePaces * CONFIG.engineerElevationAuraFactor;
    assert.equal(engineerAuraPaces(onHill), doubled);
    assert.equal(engineerAuraPaces(onPeak), doubled);
    assert.equal(engineerAuraPaces(plain), CONFIG.officerRestorePaces);
    assert.equal(shootRangeFactor(onHill), 1 + CONFIG.hillRangeBonus);
    assert.equal(shootRangeFactor(onPeak), 1);

    const farFriend = spawn(sim, "player", "troop", "top", {
      progress: progressFromPlayerPaces("player", "top", hill.centerPaces + 90),
      sublane: 2,
    });
    assert.equal(shootRangeFactor(farFriend), 1 + CONFIG.hillRangeBonus);
    const offPeak = spawn(sim, "player", "engineer", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", peak.centerPaces),
      sublane: 0,
    });
    assert.equal(auraOverlapsFeature(onPeak, woods, "default"), true);
    assert.equal(auraOverlapsFeature(offPeak, woods, "default"), false);
  });
});
