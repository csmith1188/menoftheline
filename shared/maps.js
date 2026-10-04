import { CONFIG } from "./config.js";
import { Path } from "./path.js";
import { fortFootprintPaces } from "./path.js";

/**
 * Named map presets. Features use paces from the player keep.
 * Side forts are injected at resolve time from CONFIG.fortDistancePaces.
 */

function feature(partial) {
  return {
    halfWidthPaces: fortFootprintPaces(),
    ...partial,
  };
}

/** All sublanes for a lane (forts span the whole lane). */
function allSublanes(lane) {
  const n = Path.sublaneCount(lane);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(i);
  return out;
}

function sideForts() {
  const half = fortFootprintPaces();
  const forts = [];
  for (const lane of ["top", "bottom"]) {
    const total = Path.lanePaces(lane);
    const dist = CONFIG.fortDistancePaces;
    forts.push(
      feature({
        id: `fort-player-${lane}`,
        kind: "fort",
        lane,
        sublanes: allSublanes(lane),
        centerPaces: dist,
        halfWidthPaces: half,
        sideId: "player",
      }),
      feature({
        id: `fort-enemy-${lane}`,
        kind: "fort",
        lane,
        sublanes: allSublanes(lane),
        centerPaces: total - dist,
        halfWidthPaces: half,
        sideId: "enemy",
      }),
    );
  }
  return forts;
}

/**
 * Bottom-lane sketch (F marks forts; positions stay CONFIG.fortDistancePaces):
 * outer:  F — W — W — R — W — P — F
 * mid:    F —     W — B — W —     F
 * inner:  F — P — W — R — W — W — F
 * Fractions are along the full lane (player keep → enemy keep).
 */
function bottomAt(frac) {
  return CONFIG.bottomLanePaces * frac;
}

const DEFAULT_LAYOUT = [
  // Top lane hills
  feature({
    id: "hill-top-nw",
    kind: "hill",
    lane: "top",
    sublanes: [0, 1],
    centerPaces: (CONFIG.topLanePaces * 2) / 5,
  }),
  feature({
    id: "hill-top-se",
    kind: "hill",
    lane: "top",
    sublanes: [3, 4],
    centerPaces: (CONFIG.topLanePaces * 3) / 5,
  }),

  // Bottom — left of center
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

  // Bottom — center river / bridge / river
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

  // Bottom — right of center
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

export const MAP_PRESETS = {
  default: {
    id: "default",
    label: "Default",
    layout: DEFAULT_LAYOUT,
  },
  /** No terrain features (side forts only). Used by unit tests. */
  empty: {
    id: "empty",
    label: "Empty",
    layout: [],
  },
};

/** Resolve a preset id into a full feature list (layout + side forts). */
export function resolveMapFeatures(mapId) {
  const preset = MAP_PRESETS[mapId] || MAP_PRESETS[CONFIG.defaultMapId] || MAP_PRESETS.default;
  return [...preset.layout, ...sideForts()];
}

/** List of known map preset ids. */
export function mapPresetIds() {
  return Object.keys(MAP_PRESETS);
}
