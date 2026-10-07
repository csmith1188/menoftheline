import assert from "node:assert/strict";
import test from "node:test";
import { SHOT_SNAP_PX, SNAP_PX, lerpAlpha, lerpPoint, lerpTroop } from "../public/js/interp.js";

test("lerpAlpha clamps to the snapshot gap", () => {
  assert.equal(lerpAlpha(1000, 1000, 100), 0);
  assert.equal(lerpAlpha(1050, 1000, 100), 0.5);
  assert.equal(lerpAlpha(1200, 1000, 100), 1);
  assert.equal(lerpAlpha(1000, 1000, 0), 1);
});

test("lerpTroop glides, and snaps on a row change or a large jump", () => {
  const prev = { x: 0, y: 10, lane: "top", sublane: 0 };
  const next = { x: 40, y: 10, lane: "top", sublane: 0 };
  const mid = lerpTroop(prev, next, 0.5, SNAP_PX);
  assert.equal(mid.snapped, false);
  assert.equal(mid.x, 20);
  assert.equal(mid.y, 10);

  const row = lerpTroop(prev, { x: 10, y: 30, lane: "top", sublane: 2 }, 0.5, SNAP_PX);
  assert.equal(row.snapped, true);
  assert.equal(row.x, 10);

  const far = lerpTroop(prev, { x: prev.x + SNAP_PX + 5, y: 10, lane: "top", sublane: 0 }, 0.5, SNAP_PX);
  assert.equal(far.snapped, true);
  assert.equal(far.x, prev.x + SNAP_PX + 5);

  const fresh = lerpTroop(null, next, 0, SNAP_PX);
  assert.equal(fresh.snapped, true);
  assert.equal(fresh.x, 40);
});

test("lerpPoint glides shells and snaps only on a large jump", () => {
  const prev = { x: 0, y: 0 };
  const mid = lerpPoint(prev, { x: 100, y: 0 }, 0.5, SHOT_SNAP_PX);
  assert.equal(mid.snapped, false);
  assert.equal(mid.x, 50);
  const far = lerpPoint(prev, { x: SHOT_SNAP_PX + 1, y: 0 }, 0.5, SHOT_SNAP_PX);
  assert.equal(far.snapped, true);
  assert.equal(far.x, SHOT_SNAP_PX + 1);
});
