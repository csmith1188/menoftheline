import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG } from "../shared/config.js";
import {
  normalizeMatchOptions,
  matchOptionsSummary,
  MATCH_SPEEDS,
} from "../shared/matchOptions.js";
import { resolveMapFeatures } from "../shared/maps.js";
import { clearTerrainCache, featuresOnMap, setMapOpts } from "../shared/terrain.js";
import { makeSim, spawn } from "./helpers.js";

describe("match options", () => {
  it("normalizes lobby form fields with defaults", () => {
    const opts = normalizeMatchOptions({
      speed: "1.5",
      fogEnabled: "0",
      mapId: "empty",
      fortsEnabled: "false",
      baseGps: "12",
    });
    assert.equal(opts.speed, 1.5);
    assert.equal(opts.fogEnabled, false);
    assert.equal(opts.mapId, "empty");
    assert.equal(opts.fortsEnabled, false);
    assert.equal(opts.baseGps, 12);
    assert.ok(MATCH_SPEEDS.includes(opts.speed));
  });

  it("clamps base GPS and rejects unknown maps/speeds", () => {
    const opts = normalizeMatchOptions({
      speed: 99,
      mapId: "nope",
      baseGps: 999,
    });
    assert.equal(opts.speed, 1);
    assert.equal(opts.mapId, CONFIG.defaultMapId);
    assert.equal(opts.baseGps, 50);
  });

  it("omits forts when resolveMapFeatures forts is false", () => {
    const withForts = resolveMapFeatures("empty", { forts: true });
    const without = resolveMapFeatures("empty", { forts: false });
    assert.ok(withForts.some((f) => f.kind === "fort"));
    assert.equal(without.length, 0);
  });

  it("featuresOnMap respects installed map opts", () => {
    clearTerrainCache();
    setMapOpts({ forts: false });
    assert.equal(featuresOnMap("empty").length, 0);
    setMapOpts({ forts: true });
    assert.ok(featuresOnMap("empty").some((f) => f.kind === "fort"));
    clearTerrainCache();
  });

  it("applies base GPS and fog-off to the sim", () => {
    const sim = makeSim({ mapId: "empty", baseGps: 7, fogEnabled: false });
    assert.equal(sim.baseIncome, 7);
    assert.equal(sim.fogEnabled, false);
    sim.refreshIncomes();
    assert.equal(sim.player.income, Math.round(7 + CONFIG.centerIncome * 0.5));

    const foe = spawn(sim, "enemy", "regulars", "top", { progress: 0.5 });
    const snap = sim.snapshot({ forSideId: "player" });
    assert.ok(snap.sides.enemy.troops.some((t) => t.id === foe.id));
    assert.equal(snap.fogEnabled, false);
  });

  it("summarizes options for Open Games", () => {
    const summary = matchOptionsSummary({
      mapId: "default",
      speed: 1,
      fogEnabled: true,
      fortsEnabled: false,
      baseGps: 10,
    });
    assert.equal(summary.mapLabel, "Default");
    assert.equal(summary.speedLabel, "1×");
    assert.equal(summary.fogLabel, "Fog on");
    assert.equal(summary.fortsLabel, "Forts off");
    assert.equal(summary.baseGpsLabel, "10 GPS");
  });

  it("re-applies custom options after sim.reset (listed abandon)", () => {
    const sim = makeSim();
    sim.applyMatchOptions({
      mapId: "empty",
      fogEnabled: false,
      fortsEnabled: false,
      baseGps: 15,
    });
    sim.reset();
    assert.equal(sim.mapId, CONFIG.defaultMapId);
    assert.equal(sim.fogEnabled, true);
    assert.equal(sim.baseIncome, CONFIG.baseIncome);
    sim.applyMatchOptions({
      mapId: "empty",
      fogEnabled: false,
      fortsEnabled: false,
      baseGps: 15,
    });
    assert.equal(sim.mapId, "empty");
    assert.equal(sim.fogEnabled, false);
    assert.equal(sim.fortsEnabled, false);
    assert.equal(sim.baseIncome, 15);
  });
});
