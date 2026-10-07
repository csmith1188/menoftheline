/**
 * Time one crowded match. No sockets.
 *   node scripts/load/sim-bench.js
 * Project 100 rooms from the p95 step time.
 */
import { performance } from "node:perf_hooks";
import { makeSim, spawn } from "../../test/helpers.js";

const steps = Number(process.env.BENCH_STEPS) || 200;
const perSide = Number(process.env.BENCH_UNITS) || 20;
const types = ["troop", "skirmisher", "officer", "cannon"];

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

const sim = makeSim({ mapId: "default", fogEnabled: true });
sim.player.gold = 200000;
sim.enemy.gold = 200000;
for (let i = 0; i < perSide; i += 1) {
  const type = types[i % types.length];
  const lane = i % 2 === 0 ? "top" : "bottom";
  const progress = 0.15 + (i % 5) * 0.08;
  spawn(sim, "player", type, lane, { progress, sublane: i % 3, order: "forward" });
  spawn(sim, "enemy", type, lane, { progress: 1 - progress, sublane: i % 3, order: "forward" });
}

const stepTimes = [];
const snapTimes = [];
for (let i = 0; i < steps; i += 1) {
  const a = performance.now();
  sim.beginStep(0.05);
  sim.finishStep(0.05);
  stepTimes.push((performance.now() - a) * 1000);
  const b = performance.now();
  sim.snapshotViews(["player", "enemy"]);
  snapTimes.push((performance.now() - b) * 1000);
}

const stepP95 = percentile(stepTimes, 0.95);
const snapP95 = percentile(snapTimes, 0.95);
const rooms = 100;
const report = {
  unitsPerSide: perSide,
  steps,
  stepUs: {
    p50: Math.round(percentile(stepTimes, 0.5)),
    p95: Math.round(stepP95),
  },
  snapshotViewsUs: {
    p50: Math.round(percentile(snapTimes, 0.5)),
    p95: Math.round(snapP95),
  },
  projected100RoomsStepMs: Math.round((stepP95 * rooms) / 1000),
  projected100RoomsSnapshotMs: Math.round((snapP95 * rooms) / 1000),
  budgetMs: 50,
};

console.log(JSON.stringify(report, null, 2));
if (report.projected100RoomsStepMs > 50) {
  console.log("sim step budget missed for 100 rooms");
  process.exitCode = 2;
}
