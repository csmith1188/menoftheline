import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../shared/config.js";
import { Path } from "../shared/path.js";
import {
  GameMap,
  getMap,
  mapIds,
  normalizeMapDefinition,
  computeResourceIncomes,
  classicLanesFromConfig,
} from "../shared/map/index.js";
import { resolveMapFeatures } from "../shared/maps.js";
import { makeSim } from "./helpers.js";

describe("map definitions", () => {
  it("registers classic default and empty maps", () => {
    assert.ok(mapIds().includes("default"));
    assert.ok(mapIds().includes("empty"));
    assert.equal(getMap("default").label, "Default");
    assert.equal(getMap("empty").label, "Empty");
  });

  it("normalizes classic lanes with gold/land shared resources", () => {
    const def = normalizeMapDefinition({
      id: "default",
      label: "Default",
      lanes: classicLanesFromConfig(),
    });
    assert.equal(def.lanes.length, 2);
    assert.equal(def.lanes[0].resource.type, "gold");
    assert.equal(def.lanes[0].resource.mode, "shared");
    assert.equal(def.lanes[0].resource.max, CONFIG.centerIncome);
    assert.equal(def.lanes[1].resource.type, "land");
    assert.equal(def.lanes[1].towns.placement, "innerArc");
  });

  it("rejects mismatched shared resource groups", () => {
    assert.throws(() => normalizeMapDefinition({
      id: "bad",
      lanes: [
        {
          id: "a",
          geometry: { kind: "line", sublaneCount: 1 },
          paces: 1000,
          resource: { type: "gold", min: 0, max: 10, group: "g", mode: "shared" },
        },
        {
          id: "b",
          geometry: { kind: "line", sublaneCount: 1 },
          paces: 1000,
          resource: { type: "gold", min: 0, max: 20, group: "g", mode: "shared" },
        },
      ],
    }), /mismatched/);
  });
});

describe("map features", () => {
  it("matches legacy resolveMapFeatures for default/empty", () => {
    const withForts = resolveMapFeatures("default", { forts: true });
    const without = resolveMapFeatures("default", { forts: false });
    assert.ok(withForts.length > without.length);
    assert.ok(withForts.some((f) => f.kind === "fort"));
    assert.ok(!without.some((f) => f.kind === "fort"));

    const empty = resolveMapFeatures("empty", { forts: true });
    assert.equal(empty.filter((f) => f.kind !== "fort").length, 0);
    assert.equal(empty.filter((f) => f.kind === "fort").length, 4);
  });
});

describe("resource income", () => {
  it("shared solo lanes match classic centerIncome/centerLand", () => {
    const lanes = classicLanesFromConfig();
    const mid = computeResourceIncomes(lanes, { top: 0.5, bottom: 0.5 });
    assert.equal(mid.player.gold, CONFIG.centerIncome * 0.5);
    assert.equal(mid.player.land, CONFIG.centerLand * 0.5);
    assert.equal(mid.enemy.gold, CONFIG.centerIncome * 0.5);
    assert.equal(mid.enemy.land, CONFIG.centerLand * 0.5);

    const push = computeResourceIncomes(lanes, { top: 1, bottom: 0 });
    assert.equal(push.player.gold, CONFIG.centerIncome);
    assert.equal(push.enemy.gold, 0);
    assert.equal(push.player.land, 0);
    assert.equal(push.enemy.land, CONFIG.centerLand);
  });

  it("shared groups average control before payout", () => {
    const lanes = [
      {
        id: "a",
        resource: { type: "gold", min: 0, max: 10, group: "g", mode: "shared" },
      },
      {
        id: "b",
        resource: { type: "gold", min: 0, max: 10, group: "g", mode: "shared" },
      },
    ];
    const out = computeResourceIncomes(lanes, { a: 1, b: 0 });
    assert.equal(out.player.gold, 5);
    assert.equal(out.enemy.gold, 5);
  });

  it("cumulative lanes add independent payouts", () => {
    const lanes = [
      {
        id: "a",
        resource: { type: "gold", min: 0, max: 10, group: "a", mode: "cumulative" },
      },
      {
        id: "b",
        resource: { type: "gold", min: 0, max: 10, group: "b", mode: "cumulative" },
      },
    ];
    const out = computeResourceIncomes(lanes, { a: 1, b: 1 });
    assert.equal(out.player.gold, 20);
    assert.equal(out.enemy.gold, 0);
  });
});

describe("GameSim map wiring", () => {
  it("places the same town count as CONFIG on empty map", () => {
    const sim = makeSim({ mapId: "empty" });
    assert.equal(sim.map.id, "empty");
    assert.deepEqual(sim.map.laneIds(), ["top", "bottom"]);
    assert.equal(sim.checkpoints.length, CONFIG.checkpointCount);
    assert.ok(sim.checkpoints.every((t) => t.laneId === "bottom"));
  });

  it("snapshot includes map meta and laneCenters aliases", () => {
    const sim = makeSim({ mapId: "default" });
    Path.useBoard(sim.map.boardContext());
    const snap = sim.snapshot();
    assert.equal(snap.map.id, "default");
    assert.equal(snap.map.lanes.length, 2);
    assert.equal(snap.laneCenters.top, snap.topCenter);
    assert.equal(snap.laneCenters.bottom, snap.bottomCenter);
  });

  it("income at even push matches classic base + half center pools", () => {
    const sim = makeSim({ mapId: "empty", baseGps: 10 });
    sim.refreshIncomes();
    assert.equal(sim.player.income, 10 + CONFIG.centerIncome * 0.5);
    assert.equal(sim.player.landIncome, CONFIG.centerLand * 0.5);
  });
});

describe("GameMap.fromDefinition", () => {
  it("accepts tool-style plain JSON and registers via constructor", () => {
    const map = GameMap.fromDefinition({
      id: "fixture-temp",
      label: "Fixture",
      lanes: classicLanesFromConfig(),
      features: [],
    });
    assert.equal(map.id, "fixture-temp");
    assert.equal(map.features({ forts: false }).length, 0);
    assert.equal(map.features({ forts: true }).filter((f) => f.kind === "fort").length, 4);
  });
});
