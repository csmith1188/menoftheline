import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG, pointerHitReach } from "../shared/config.js";

const phoneScale = 390 / CONFIG.canvasWidth;
const topZoom = (CONFIG.canvasHeight * 0.62) / CONFIG.topLaneHeight;

test("overview unit reach stays generous on a phone-sized canvas", () => {
  const reach = pointerHitReach({
    cssScale: phoneScale,
    zoom: 1,
    coarse: true,
    telescope: false,
    kind: "unit",
  });
  // ~24 CSS px of pad beyond the body (world = css / scale).
  assert.ok(reach > 50);
  assert.ok(reach < 70);
});

test("telescope unit reach shrinks so pans are not stolen on phones", () => {
  const reach = pointerHitReach({
    cssScale: phoneScale,
    zoom: topZoom,
    coarse: true,
    telescope: true,
    kind: "unit",
  });
  const hitR = 10 + reach;
  const diamCss = hitR * phoneScale * topZoom * 2;
  // Old formula (body + max(10, 24/scale), no zoom) was ~193 CSS px.
  assert.ok(diamCss < 70, `expected <70 CSS px diameter, got ${diamCss}`);
  assert.ok(diamCss > 40, `expected usable tap size, got ${diamCss}`);
  assert.ok(reach < 15);
});

test("town reach also respects telescope zoom", () => {
  const overview = pointerHitReach({
    cssScale: phoneScale,
    zoom: 1,
    telescope: false,
    kind: "town",
  });
  const zoomed = pointerHitReach({
    cssScale: phoneScale,
    zoom: topZoom,
    telescope: true,
    kind: "town",
  });
  assert.ok(zoomed < overview / 2);
});
