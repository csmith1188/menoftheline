import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../shared/config.js";
import { Path, clearWorldPointsCache, distance } from "../shared/path.js";

test("worldPoints returns the same array for the same lane/sublane", () => {
  clearWorldPointsCache();
  const a = Path.worldPoints("top", 2);
  const b = Path.worldPoints("top", 2);
  assert.equal(a, b);
  const c = Path.worldPoints("bottom", 1);
  const d = Path.worldPoints("bottom", 1);
  assert.equal(c, d);
  assert.notEqual(a, c);
});

test("cached top polyline matches keep endpoints and spread", () => {
  clearWorldPointsCache();
  const pts = Path.worldPoints("top", 0);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].x, CONFIG.playerKeep.x);
  assert.equal(pts[1].x, CONFIG.enemyKeep.x);
  const n = Path.sublaneNorm(0, CONFIG.topSublaneCount);
  const y = CONFIG.playerKeep.y + n * CONFIG.topSublaneSpread;
  assert.equal(pts[0].y, y);
  assert.equal(pts[1].y, y);
});

test("cached bottom arc has expected segment count and endpoints on the ring", () => {
  clearWorldPointsCache();
  const sub = 1;
  const pts = Path.worldPoints("bottom", sub);
  assert.equal(pts.length, CONFIG.bottomArcSegments + 1);
  const c = Path.bottomCenter();
  const r = Path.bottomRadius(sub);
  const start = pts[0];
  const end = pts[pts.length - 1];
  assert.ok(Math.abs(distance(start, c) - r) < 1e-6);
  assert.ok(Math.abs(distance(end, c) - r) < 1e-6);
  assert.ok(Math.abs(start.x - CONFIG.playerKeep.x) < 1e-6);
  assert.ok(Math.abs(end.x - CONFIG.enemyKeep.x) < 1e-6);
});

test("clearWorldPointsCache forces a new array identity", () => {
  clearWorldPointsCache();
  const before = Path.worldPoints("top", 1);
  clearWorldPointsCache();
  const after = Path.worldPoints("top", 1);
  assert.notEqual(before, after);
  assert.deepEqual(before, after);
});
