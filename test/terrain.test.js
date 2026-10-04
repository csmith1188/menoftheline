import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { CONFIG } from "../shared/config.js";
import { fortFootprintPaces } from "../shared/path.js";
import {
  canOccupy,
  clearTerrainCache,
  featuresOnMap,
  foggedFeatureIds,
  canSeePace,
  fogLaneRegions,
  hasShotLos,
  isEnemyVisible,
  moveSpeedFactor,
  onTerrain,
  openSegmentAt,
  shootRangeFactor,
  terrainCover,
  unitsInMeleeContact,
} from "../shared/terrain.js";
import { mobilityClass } from "../shared/units.js";
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

/** Terrain tests use the default map preset. */
function makeTerrainSim() {
  return makeSim({ mapId: "default" });
}

function featureById(id) {
  return featuresOnMap("default").find((f) => f.id === id);
}

describe("terrain map preset", () => {
  it("default map includes hills, rivers, bridge, woods, peaks, and forts", () => {
    const features = featuresOnMap("default");
    const kinds = features.map((f) => f.kind);
    assert.ok(kinds.includes("hill"));
    assert.ok(kinds.includes("river"));
    assert.ok(kinds.includes("bridge"));
    assert.ok(kinds.includes("woods"));
    assert.ok(kinds.includes("peak"));
    assert.ok(kinds.includes("fort"));
    const hillNw = features.find((f) => f.id === "hill-top-nw");
    assert.ok(hillNw);
    assert.deepEqual(hillNw.sublanes, [0, 1]);
    assert.equal(hillNw.centerPaces, (CONFIG.topLanePaces * 2) / 5);
  });
});

describe("mobility classes", () => {
  it("classifies infantry, cavalry, and artillery", () => {
    assert.equal(mobilityClass("troop"), "infantry");
    assert.equal(mobilityClass("dragoon"), "cavalry");
    assert.equal(mobilityClass("lancer"), "cavalry");
    assert.equal(mobilityClass("cannon"), "artillery");
    assert.equal(mobilityClass("howitzer"), "artillery");
  });
});

describe("terrain movement", () => {
  it("slows infantry on woods and blocks cavalry on peaks", () => {
    const sim = makeTerrainSim();
    const woods = featureById("woods-bottom-outer-a");
    const woodsUnit = spawn(sim, "player", "troop", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", woods.centerPaces),
      sublane: 0,
    });
    assert.ok(onTerrain(woodsUnit, woods));
    assert.equal(moveSpeedFactor(woodsUnit), CONFIG.woodsSlow);

    const peak = featureById("peak-bottom-inner-a");
    assert.equal(canOccupy("dragoon", "bottom", 2, peak.centerPaces), false);
    assert.equal(canOccupy("troop", "bottom", 2, peak.centerPaces), true);
    assert.equal(canOccupy("cannon", "bottom", 0, CONFIG.bottomLanePaces / 2), false);
  });

  it("applies hill slope relative to own keep", () => {
    const sim = makeTerrainSim();
    const center = featureById("hill-top-nw").centerPaces;
    const before = spawn(sim, "player", "troop", "top", {
      progress: progressFromPlayerPaces("player", "top", center - 10),
      sublane: 0,
    });
    const after = spawn(sim, "player", "troop", "top", {
      progress: progressFromPlayerPaces("player", "top", center + 10),
      sublane: 0,
    });
    assert.ok(Math.abs(moveSpeedFactor(before) - (1 - CONFIG.hillSlope)) < 1e-9);
    assert.ok(Math.abs(moveSpeedFactor(after) - (1 + CONFIG.hillSlope)) < 1e-9);
  });

  it("grants hill range bonus on the footprint", () => {
    const sim = makeTerrainSim();
    const center = featureById("hill-top-nw").centerPaces;
    const onHill = spawn(sim, "player", "troop", "top", {
      progress: progressFromPlayerPaces("player", "top", center),
      sublane: 0,
    });
    const offHill = spawn(sim, "player", "troop", "top", {
      progress: progressFromPlayerPaces("player", "top", center),
      sublane: 2,
    });
    assert.equal(shootRangeFactor(onHill), 1 + CONFIG.hillRangeBonus);
    assert.equal(shootRangeFactor(offHill), 1);
    assert.ok(onHill.relevantRangePaces() > offHill.relevantRangePaces());
  });
});

describe("terrain cover and LOS", () => {
  it("gives woods cover and hill cover when attacker is off the hill", () => {
    const sim = makeTerrainSim();
    const woods = featureById("woods-bottom-outer-a").centerPaces;
    const def = spawn(sim, "player", "troop", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", woods),
      sublane: 0,
    });
    const atk = spawn(sim, "enemy", "troop", "bottom", {
      progress: progressFromPlayerPaces("enemy", "bottom", woods + 200),
      sublane: 0,
    });
    assert.equal(terrainCover(def, atk), true);

    const hill = featureById("hill-top-nw").centerPaces;
    const hillDef = spawn(sim, "player", "skirmisher", "top", {
      progress: progressFromPlayerPaces("player", "top", hill),
      sublane: 0,
    });
    const hillAtk = spawn(sim, "enemy", "skirmisher", "top", {
      progress: progressFromPlayerPaces("enemy", "top", hill + 120),
      sublane: 0,
    });
    assert.equal(terrainCover(hillDef, hillAtk), true);
    assert.equal(terrainCover(hillDef, hillDef), false);
  });

  it("blocks LOS past a hill unless the viewer occupies it", () => {
    const sim = makeTerrainSim();
    const hill = featureById("hill-top-nw").centerPaces;
    const half = fortFootprintPaces();
    const observer = spawn(sim, "player", "troop", "top", {
      progress: progressFromPlayerPaces("player", "top", hill - half - 40),
      sublane: 0,
    });
    const target = spawn(sim, "enemy", "troop", "top", {
      progress: progressFromPlayerPaces("enemy", "top", CONFIG.topLanePaces - (hill + half + 40)),
      sublane: 0,
    });
    // Place enemy so player-paces are past the hill.
    target.progress = progressFromPlayerPaces("enemy", "top", hill + half + 80);
    target.syncPosition();

    const tb = troopsBySide(sim);
    assert.equal(hasShotLos(observer, target, "player", tb), false);

    // Move observer onto the hill to cancel the block.
    observer.progress = progressFromPlayerPaces("player", "top", hill);
    observer.syncPosition();
    assert.equal(hasShotLos(observer, target, "player", tb), true);
  });

  it("allows shooting a unit standing on a hill footprint", () => {
    const sim = makeTerrainSim();
    const hill = featureById("hill-top-nw").centerPaces;
    const half = fortFootprintPaces();
    const observer = spawn(sim, "player", "troop", "top", {
      progress: progressFromPlayerPaces("player", "top", hill - half - 40),
      sublane: 0,
      order: "halt",
    });
    const onHill = spawn(sim, "enemy", "troop", "top", {
      progress: progressFromPlayerPaces("enemy", "top", hill),
      sublane: 0,
      order: "halt",
    });
    onHill.progress = progressFromPlayerPaces("enemy", "top", hill);
    onHill.syncPosition();
    const tb = troopsBySide(sim);
    assert.equal(hasShotLos(observer, onHill, "player", tb), true);
    assert.equal(isEnemyVisible("player", onHill, tb), true);
    assert.ok(observer.inShotRange(onHill, observer.shootRange()));
  });

  it("always shows an enemy in melee even inside woods", () => {
    const sim = makeTerrainSim();
    const woodsFeat = featureById("woods-bottom-outer-a");
    const woods = woodsFeat.centerPaces;
    const half = fortFootprintPaces();
    // Friend just outside the woods; enemy just inside — melee contact, no occupy.
    const friend = spawn(sim, "player", "troop", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", woods - half - 2),
      sublane: 0,
    });
    const hidden = spawn(sim, "enemy", "troop", "bottom", {
      progress: progressFromPlayerPaces("enemy", "bottom", woods - half + 2),
      sublane: 0,
    });
    hidden.progress = progressFromPlayerPaces("enemy", "bottom", woods - half + 2);
    hidden.syncPosition();

    assert.equal(onTerrain(friend, woodsFeat), false);
    assert.equal(onTerrain(hidden, woodsFeat), true);
    assert.ok(unitsInMeleeContact(friend, hidden));
    assert.equal(isEnemyVisible("player", hidden, troopsBySide(sim)), true);
    const snap = sim.snapshot({ forSideId: "player" });
    assert.ok(snap.sides.enemy.troops.some((t) => t.id === hidden.id));
  });

  it("hides woods occupants unless the viewer also occupies that woods", () => {
    const sim = makeTerrainSim();
    const woods = featureById("woods-bottom-outer-a").centerPaces;
    const hidden = spawn(sim, "enemy", "troop", "bottom", {
      progress: progressFromPlayerPaces("enemy", "bottom", woods),
      sublane: 0,
    });
    // Enemy progress: player paces = woods means enemy progress = 1 - woods/total
    hidden.progress = progressFromPlayerPaces("enemy", "bottom", woods);
    hidden.syncPosition();

    const tb = troopsBySide(sim);
    assert.equal(isEnemyVisible("player", hidden, tb), false);

    spawn(sim, "player", "troop", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", woods),
      sublane: 0,
    });
    assert.equal(isEnemyVisible("player", hidden, troopsBySide(sim)), true);
  });

  it("forts block LOS only for the non-owning side", () => {
    const sim = makeTerrainSim();
    const fort = CONFIG.fortDistancePaces;
    const half = fortFootprintPaces();
    // Player unit behind own fort looking past it — own fort does not block.
    const player = spawn(sim, "player", "troop", "top", {
      progress: progressFromPlayerPaces("player", "top", fort - half - 20),
      sublane: 2,
    });
    const foe = spawn(sim, "enemy", "troop", "top", {
      progress: progressFromPlayerPaces("enemy", "top", fort + half + 80),
      sublane: 2,
    });
    foe.progress = progressFromPlayerPaces("enemy", "top", fort + half + 80);
    foe.syncPosition();
    const tb = troopsBySide(sim);
    assert.equal(hasShotLos(player, foe, "player", tb), true);

    // Enemy looking toward player through player's fort without occupying it.
    const enemyViewer = spawn(sim, "enemy", "skirmisher", "top", {
      progress: progressFromPlayerPaces("enemy", "top", fort + half + 200),
      sublane: 2,
    });
    enemyViewer.progress = progressFromPlayerPaces("enemy", "top", fort + half + 200);
    enemyViewer.syncPosition();
    assert.equal(hasShotLos(enemyViewer, player, "enemy", tb), false);
  });
});

describe("fog snapshot", () => {
  it("redacts hidden enemy troops from per-side snapshots", () => {
    const sim = makeTerrainSim();
    const woods = featureById("woods-bottom-outer-a").centerPaces;
    const hidden = spawn(sim, "enemy", "troop", "bottom", {
      progress: progressFromPlayerPaces("enemy", "bottom", woods),
      sublane: 0,
    });
    hidden.progress = progressFromPlayerPaces("enemy", "bottom", woods);
    hidden.syncPosition();
    spawn(sim, "player", "troop", "top", {
      progress: 0.1,
      sublane: 2,
    });

    const full = sim.snapshot();
    assert.equal(full.sides.enemy.troops.length, 1);

    const fogged = sim.snapshot({ forSideId: "player" });
    assert.equal(fogged.sides.enemy.troops.length, 0);
    assert.ok(fogged.terrain.foggedFeatureIds.includes("woods-bottom-outer-a"));
    assert.ok(foggedFeatureIds("player", troopsBySide(sim)).length > 0);
  });

  it("reveals an enemy standing on a hill footprint when LOS reaches it", () => {
    const sim = makeTerrainSim();
    const hill = featureById("hill-top-nw").centerPaces;
    const onHill = spawn(sim, "enemy", "troop", "top", {
      progress: progressFromPlayerPaces("enemy", "top", hill),
      sublane: 0,
    });
    onHill.progress = progressFromPlayerPaces("enemy", "top", hill);
    onHill.syncPosition();
    assert.equal(isEnemyVisible("player", onHill, troopsBySide(sim)), true);
    const snap = sim.snapshot({ forSideId: "player" });
    assert.equal(snap.sides.enemy.troops.length, 1);
  });

  it("hides units on the enemy fort when a hill blocks the row before it", () => {
    const sim = makeTerrainSim();
    // Top rows 0–1 have a hill; enemy fort is past that hill.
    const fort = CONFIG.topLanePaces - CONFIG.fortDistancePaces;
    const onFort = spawn(sim, "enemy", "troop", "top", {
      progress: progressFromPlayerPaces("enemy", "top", fort),
      sublane: 0,
    });
    onFort.progress = progressFromPlayerPaces("enemy", "top", fort);
    onFort.syncPosition();
    assert.equal(isEnemyVisible("player", onFort, troopsBySide(sim)), false);

    // Middle row has no hill — fort occupants remain visible.
    const clearRow = spawn(sim, "enemy", "skirmisher", "top", {
      progress: progressFromPlayerPaces("enemy", "top", fort),
      sublane: 2,
    });
    clearRow.progress = progressFromPlayerPaces("enemy", "top", fort);
    clearRow.syncPosition();
    assert.equal(isEnemyVisible("player", clearRow, troopsBySide(sim)), true);
  });

  it("marks open row segments past LOS blockers as fogged, not terrain footprints", () => {
    const sim = makeTerrainSim();
    const regions = fogLaneRegions("player", troopsBySide(sim), "default");
    assert.ok(regions.length > 0);
    // Near own keep on middle top row (no hill): should be visible.
    const nearKeep = regions.find((r) =>
      r.lane === "top" && r.sublane === 2 && r.minPaces < 50);
    assert.ok(nearKeep);
    assert.equal(nearKeep.fogged, false);
    // Past the NW hill on row 0, far side should be fogged without an occupant.
    const hillCenter = featureById("hill-top-nw").centerPaces;
    const pastHill = regions.find((r) =>
      r.lane === "top" && r.sublane === 0 && r.minPaces > hillCenter);
    assert.ok(pastHill);
    assert.equal(pastHill.fogged, true);
    const snap = sim.snapshot({ forSideId: "player" });
    assert.ok(snap.terrain.fogRegions.some((r) => r.fogged));
  });

  it("crests an open segment across rows after a blocker centerline", () => {
    const sim = makeTerrainSim();
    const woodsAb = featureById("woods-bottom-ab");
    const peak = featureById("peak-bottom-inner-a");
    const woodsInner = featureById("woods-bottom-inner-b");
    const woodsOuterA = featureById("woods-bottom-outer-a");
    const half = fortFootprintPaces();
    // Outer row, player side: just past the forest toward the river (still
    // before the inner forest footprint that closes the peak–forest gap).
    const between = woodsAb.centerPaces + half + 10;
    spawn(sim, "player", "troop", "bottom", {
      progress: progressFromPlayerPaces("player", "bottom", between),
      sublane: 0,
    });
    const tb = troopsBySide(sim);

    // Inner row segment between peak and forest — same crest window.
    const peakWoodsMid = (peak.centerPaces + woodsInner.centerPaces) / 2;
    assert.equal(
      canSeePace("player", "bottom", 2, peakWoodsMid, tb, "default"),
      true,
    );
    const peakWoodsSeg = openSegmentAt("bottom", 2, peakWoodsMid, "default");
    assert.ok(peakWoodsSeg);
    const regions = fogLaneRegions("player", tb, "default");
    const revealed = regions.find((r) =>
      r.lane === "bottom"
      && r.sublane === 2
      && r.minPaces <= peakWoodsMid
      && r.maxPaces >= peakWoodsMid);
    assert.ok(revealed);
    assert.equal(revealed.fogged, false);

    // Outer row segment between the two forests — unit is past that gap.
    const forestGapMid = (woodsOuterA.centerPaces + woodsAb.centerPaces) / 2;
    assert.equal(
      canSeePace("player", "bottom", 0, forestGapMid, tb, "default"),
      false,
    );
    const forestGap = regions.find((r) =>
      r.lane === "bottom"
      && r.sublane === 0
      && r.minPaces <= forestGapMid
      && r.maxPaces >= forestGapMid);
    assert.ok(forestGap);
    assert.equal(forestGap.fogged, true);

    // River paces sit inside the post-forest open segment, not a separate cut.
    const river = featureById("river-bottom-outer");
    const acrossRiver = openSegmentAt("bottom", 0, river.centerPaces, "default");
    assert.ok(acrossRiver);
    assert.ok(acrossRiver.minPaces < river.centerPaces);
    assert.ok(acrossRiver.maxPaces > river.centerPaces);
  });
});
