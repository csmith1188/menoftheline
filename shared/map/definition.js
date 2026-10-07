import { CONFIG } from "../config.js";

const RESOURCE_TYPES = new Set(["gold", "land", null]);
const RESOURCE_MODES = new Set(["shared", "cumulative"]);
const GEOMETRY_KINDS = new Set(["line", "arc"]);
const TOWN_PLACEMENTS = new Set(["innerArc"]);

/**
 * Classic board geometry taken from CONFIG (fallback when no map is installed).
 */
export function classicBoardFromConfig() {
  return {
    canvasWidth: CONFIG.canvasWidth,
    canvasHeight: CONFIG.canvasHeight,
    playerCapital: { ...CONFIG.playerCapital },
    enemyCapital: { ...CONFIG.enemyCapital },
    capitalRadius: CONFIG.capitalRadius,
  };
}

/** Classic top + bottom lane definitions matching today's CONFIG. */
export function classicLanesFromConfig() {
  return [
    {
      id: "top",
      geometry: {
        kind: "line",
        height: CONFIG.topLaneHeight,
        sublaneCount: CONFIG.topSublaneCount,
        sublaneSpread: CONFIG.topSublaneSpread,
        sublaneWidth: CONFIG.topSublaneWidth,
      },
      paces: CONFIG.topLanePaces,
      resource: {
        type: "gold",
        min: 0,
        max: CONFIG.centerIncome,
        group: "gold",
        mode: "shared",
      },
    },
    {
      id: "bottom",
      geometry: {
        kind: "arc",
        sublaneCount: CONFIG.bottomSublaneCount,
        sublaneSpread: CONFIG.bottomSublaneSpread,
        sublaneWidth: CONFIG.bottomSublaneWidth,
        arcSegments: CONFIG.bottomArcSegments,
      },
      paces: CONFIG.bottomLanePaces,
      resource: {
        type: "land",
        min: 0,
        max: CONFIG.centerLand,
        group: "land",
        mode: "shared",
      },
      towns: {
        placement: "innerArc",
        count: CONFIG.checkpointCount,
      },
    },
  ];
}

function asFinite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePoint(pt, fallback) {
  if (!pt || typeof pt !== "object") return { ...fallback };
  return {
    x: asFinite(pt.x, fallback.x),
    y: asFinite(pt.y, fallback.y),
  };
}

function normalizeResource(raw, fallbackType) {
  const src = raw && typeof raw === "object" ? raw : {};
  let type = src.type === undefined ? fallbackType : src.type;
  if (type === "none" || type === "") type = null;
  if (!RESOURCE_TYPES.has(type)) type = fallbackType;

  const mode = RESOURCE_MODES.has(src.mode) ? src.mode : "shared";
  const min = asFinite(src.min, 0);
  let max = asFinite(src.max, type === "gold" ? CONFIG.centerIncome : type === "land" ? CONFIG.centerLand : 0);
  if (max < min) max = min;

  let group = src.group != null ? String(src.group) : type || "none";
  if (!group) group = "none";

  return { type, min, max, group, mode };
}

function normalizeGeometry(raw, laneId) {
  const src = raw && typeof raw === "object" ? raw : {};
  const kind = GEOMETRY_KINDS.has(src.kind)
    ? src.kind
    : laneId === "bottom"
      ? "arc"
      : "line";

  if (kind === "arc") {
    return {
      kind: "arc",
      sublaneCount: Math.max(1, Math.round(asFinite(src.sublaneCount, CONFIG.bottomSublaneCount))),
      sublaneSpread: asFinite(src.sublaneSpread, CONFIG.bottomSublaneSpread),
      sublaneWidth: asFinite(src.sublaneWidth, CONFIG.bottomSublaneWidth),
      arcSegments: Math.max(2, Math.round(asFinite(src.arcSegments, CONFIG.bottomArcSegments))),
    };
  }

  return {
    kind: "line",
    height: asFinite(src.height, CONFIG.topLaneHeight),
    sublaneCount: Math.max(1, Math.round(asFinite(src.sublaneCount, CONFIG.topSublaneCount))),
    sublaneSpread: asFinite(src.sublaneSpread, CONFIG.topSublaneSpread),
    sublaneWidth: asFinite(src.sublaneWidth, CONFIG.topSublaneWidth),
  };
}

function normalizeTowns(raw) {
  if (!raw || typeof raw !== "object") return null;
  const placement = TOWN_PLACEMENTS.has(raw.placement) ? raw.placement : "innerArc";
  const count = Math.max(0, Math.round(asFinite(raw.count, CONFIG.checkpointCount)));
  if (count <= 0) return null;
  return { placement, count };
}

function normalizeFeature(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "");
  const kind = String(raw.kind || "");
  const lane = String(raw.lane || "");
  if (!id || !kind || !lane) return null;
  const sublanes = Array.isArray(raw.sublanes)
    ? raw.sublanes.map((s) => Math.round(Number(s))).filter((s) => Number.isFinite(s) && s >= 0)
    : [];
  return {
    id,
    kind,
    lane,
    sublanes,
    centerPaces: asFinite(raw.centerPaces, 0),
    halfWidthPaces: asFinite(raw.halfWidthPaces, CONFIG.footprintPaces * 2),
    sideId: raw.sideId != null ? String(raw.sideId) : null,
  };
}

function validateSharedGroups(lanes) {
  /** @type {Map<string, { type: any, min: number, max: number }>} */
  const groups = new Map();
  for (const lane of lanes) {
    const r = lane.resource;
    if (!r || r.type == null || r.mode !== "shared") continue;
    const key = `${r.type}:${r.group}`;
    const prev = groups.get(key);
    if (!prev) {
      groups.set(key, { type: r.type, min: r.min, max: r.max });
      continue;
    }
    if (prev.type !== r.type || prev.min !== r.min || prev.max !== r.max) {
      throw new Error(
        `Map shared resource group "${r.group}" has mismatched type/min/max on lane "${lane.id}"`,
      );
    }
  }
}

/**
 * Normalize and validate a map definition. Throws on invalid shared groups.
 * Accepts partial defs; fills classic defaults for missing board/lanes.
 */
export function normalizeMapDefinition(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const id = String(src.id || CONFIG.defaultMapId || "default");
  const label = String(src.label || id);

  const boardSrc = src.board && typeof src.board === "object" ? src.board : {};
  const classicBoard = classicBoardFromConfig();
  const board = {
    canvasWidth: asFinite(boardSrc.canvasWidth, classicBoard.canvasWidth),
    canvasHeight: asFinite(boardSrc.canvasHeight, classicBoard.canvasHeight),
    playerCapital: normalizePoint(boardSrc.playerCapital, classicBoard.playerCapital),
    enemyCapital: normalizePoint(boardSrc.enemyCapital, classicBoard.enemyCapital),
    capitalRadius: asFinite(boardSrc.capitalRadius, classicBoard.capitalRadius),
  };

  const classicLanes = classicLanesFromConfig();
  const laneSrc = Array.isArray(src.lanes) && src.lanes.length > 0 ? src.lanes : classicLanes;
  const lanes = [];
  const seen = new Set();
  for (const entry of laneSrc) {
    if (!entry || typeof entry !== "object") continue;
    const laneId = String(entry.id || "");
    if (!laneId || seen.has(laneId)) continue;
    seen.add(laneId);
    const fallbackType = laneId === "top" ? "gold" : laneId === "bottom" ? "land" : null;
    const geometry = normalizeGeometry(entry.geometry, laneId);
    const paces = Math.max(1, asFinite(entry.paces, laneId === "bottom" ? CONFIG.bottomLanePaces : CONFIG.topLanePaces));
    const resource = normalizeResource(entry.resource, fallbackType);
    const towns = normalizeTowns(entry.towns);
    const lane = { id: laneId, geometry, paces, resource };
    if (towns) lane.towns = towns;
    lanes.push(lane);
  }
  if (lanes.length === 0) {
    throw new Error(`Map "${id}" must define at least one lane`);
  }
  validateSharedGroups(lanes);

  const fortsSrc = src.forts && typeof src.forts === "object" ? src.forts : {};
  const forts = {
    distancePaces: asFinite(fortsSrc.distancePaces, CONFIG.fortDistancePaces),
  };

  const features = [];
  if (Array.isArray(src.features)) {
    for (const f of src.features) {
      const norm = normalizeFeature(f);
      if (norm) features.push(norm);
    }
  }

  const config = src.config && typeof src.config === "object" ? { ...src.config } : {};
  const rules = src.rules && typeof src.rules === "object" ? { ...src.rules } : {};

  return {
    id,
    label,
    board,
    lanes,
    forts,
    features,
    config,
    rules,
  };
}
