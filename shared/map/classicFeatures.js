import { CONFIG } from "../config.js";

/**
 * Default map terrain layout (paces from the player keep).
 * Bottom-lane sketch (F = forts at resolve time):
 * outer:  F — W — W — R — W — P — F
 * mid:    F —     W — B — W —     F
 * inner:  F — P — W — R — W — W — F
 */
function feature(partial) {
  return {
    halfWidthPaces: CONFIG.footprintPaces * 2,
    sideId: null,
    ...partial,
  };
}

function bottomAt(frac) {
  return CONFIG.bottomLanePaces * frac;
}

export const CLASSIC_FEATURES = [
  feature({
    id: "hill-top-nw",
    kind: "hill",
    lane: "top",
    sublanes: [0, 1],
    centerPaces: (CONFIG.topLanePaces * 1) / 3,
  }),
  feature({
    id: "hill-top-se",
    kind: "hill",
    lane: "top",
    sublanes: [3, 4],
    centerPaces: (CONFIG.topLanePaces * 2) / 3,
  }),

  feature({
    id: "woods-bottom-outer-a",
    kind: "woods",
    lane: "bottom",
    sublanes: [0],
    centerPaces: bottomAt(0.228),
  }),
  feature({
    id: "peak-bottom-inner-a",
    kind: "peak",
    lane: "bottom",
    sublanes: [2],
    centerPaces: bottomAt(0.295),
  }),
  feature({
    id: "woods-bottom-ab",
    kind: "woods",
    lane: "bottom",
    sublanes: [0, 1],
    centerPaces: bottomAt(0.362),
  }),
  feature({
    id: "woods-bottom-inner-b",
    kind: "woods",
    lane: "bottom",
    sublanes: [2],
    centerPaces: bottomAt(0.430),
  }),

  feature({
    id: "river-bottom-outer",
    kind: "river",
    lane: "bottom",
    sublanes: [0],
    centerPaces: bottomAt(0.5),
  }),
  feature({
    id: "bridge-bottom-mid",
    kind: "bridge",
    lane: "bottom",
    sublanes: [1],
    centerPaces: bottomAt(0.5),
  }),
  feature({
    id: "river-bottom-inner",
    kind: "river",
    lane: "bottom",
    sublanes: [2],
    centerPaces: bottomAt(0.5),
  }),

  feature({
    id: "woods-bottom-outer-c",
    kind: "woods",
    lane: "bottom",
    sublanes: [0],
    centerPaces: bottomAt(0.564),
  }),
  feature({
    id: "woods-bottom-cd",
    kind: "woods",
    lane: "bottom",
    sublanes: [1, 2],
    centerPaces: bottomAt(0.631),
  }),
  feature({
    id: "peak-bottom-outer-d",
    kind: "peak",
    lane: "bottom",
    sublanes: [0],
    centerPaces: bottomAt(0.698),
  }),
  feature({
    id: "woods-bottom-inner-e",
    kind: "woods",
    lane: "bottom",
    sublanes: [2],
    centerPaces: bottomAt(0.765),
  }),
];
