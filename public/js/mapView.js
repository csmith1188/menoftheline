import { CONFIG } from "../shared/config.js";
import { getMap } from "../shared/maps.js";
import { Path } from "../shared/path.js";

/** Rebuild a Path board context from snapshot.map meta. */
export function boardContextFromMeta(meta) {
  if (!meta || !Array.isArray(meta.lanes)) return null;
  const lanes = {};
  const laneIds = [];
  for (let i = 0; i < meta.lanes.length; i += 1) {
    const lane = meta.lanes[i];
    if (!lane || !lane.id) continue;
    laneIds.push(lane.id);
    lanes[lane.id] = {
      id: lane.id,
      paces: lane.paces,
      geometry: { ...lane.geometry },
      resource: lane.resource ? { ...lane.resource } : null,
      towns: lane.towns ? { ...lane.towns } : null,
    };
  }
  if (!laneIds.length) return null;
  const board = meta.board || {};
  const lineLane = meta.lanes.find((l) => l.geometry && l.geometry.kind === "line");
  return {
    mapId: meta.id,
    canvasWidth: board.canvasWidth != null ? board.canvasWidth : CONFIG.canvasWidth,
    canvasHeight: board.canvasHeight != null ? board.canvasHeight : CONFIG.canvasHeight,
    playerCapital: board.playerCapital
      ? { ...board.playerCapital }
      : { ...CONFIG.playerCapital },
    enemyCapital: board.enemyCapital
      ? { ...board.enemyCapital }
      : { ...CONFIG.enemyCapital },
    capitalRadius: board.capitalRadius != null ? board.capitalRadius : CONFIG.capitalRadius,
    fortDistancePaces: meta.fortDistancePaces != null
      ? meta.fortDistancePaces
      : CONFIG.fortDistancePaces,
    paceRulerLaneId: (lineLane && lineLane.id) || laneIds[0],
    laneIds,
    lanes,
  };
}

/** Install Path board from a state snapshot or map id. */
export function installMapView(snapOrMapId) {
  if (snapOrMapId && typeof snapOrMapId === "object") {
    const fromMeta = boardContextFromMeta(snapOrMapId.map);
    if (fromMeta) {
      Path.useBoard(fromMeta);
      return fromMeta;
    }
    const map = getMap(snapOrMapId.mapId || CONFIG.defaultMapId);
    if (map) {
      const ctx = map.boardContext();
      Path.useBoard(ctx);
      return ctx;
    }
    return null;
  }
  const map = getMap(snapOrMapId || CONFIG.defaultMapId);
  if (map) {
    const ctx = map.boardContext();
    Path.useBoard(ctx);
    return ctx;
  }
  return null;
}

export function isArcLane(laneId) {
  const def = Path.laneDef(laneId);
  if (def && def.geometry) return def.geometry.kind === "arc";
  return laneId === "bottom";
}

export function isLineLane(laneId) {
  const def = Path.laneDef(laneId);
  if (def && def.geometry) return def.geometry.kind === "line";
  return laneId === "top";
}

export function laneStrokeWidth(laneId) {
  const def = Path.laneDef(laneId);
  if (def && def.geometry && def.geometry.sublaneWidth != null) {
    return def.geometry.sublaneWidth;
  }
  return isArcLane(laneId) ? CONFIG.bottomSublaneWidth : CONFIG.topSublaneWidth;
}

export function laneRowColor(laneId) {
  return isArcLane(laneId) ? CONFIG.colors.bottomSublane : CONFIG.colors.topSublane;
}

export function laneFogColor(laneId) {
  return isArcLane(laneId) ? "#2a2218" : "#1a2e28";
}

/** Prefer first line lane for "up", first arc for "down". */
export function swipeBuyLanes() {
  const ids = Path.laneIds();
  let line = null;
  let arc = null;
  for (let i = 0; i < ids.length; i += 1) {
    if (!line && isLineLane(ids[i])) line = ids[i];
    if (!arc && isArcLane(ids[i])) arc = ids[i];
  }
  return {
    up: line || ids[0] || "top",
    down: arc || ids[ids.length - 1] || "bottom",
  };
}
