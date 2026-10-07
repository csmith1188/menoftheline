import { CONFIG } from "../config.js";
import { normalizeMapDefinition } from "./definition.js";

function allSublaneIndexes(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(i);
  return out;
}

/**
 * Runtime map: validated definition + helpers for Path, sim, terrain, clients.
 */
export class GameMap {
  /**
   * @param {object} definition raw or already-normalized map definition
   */
  constructor(definition) {
    this.def = normalizeMapDefinition(definition);
    /** @type {Map<string, object>} */
    this._lanesById = new Map(this.def.lanes.map((l) => [l.id, l]));
  }

  /** Build from a plain (tool-friendly) definition object. */
  static fromDefinition(definition) {
    return new GameMap(definition);
  }

  get id() {
    return this.def.id;
  }

  get label() {
    return this.def.label;
  }

  laneIds() {
    return this.def.lanes.map((l) => l.id);
  }

  lane(id) {
    return this._lanesById.get(id) || null;
  }

  hasLane(id) {
    return this._lanesById.has(id);
  }

  board() {
    return this.def.board;
  }

  /** Context object installed into Path for geometry lookups. */
  boardContext() {
    const board = this.def.board;
    const lanes = {};
    for (const lane of this.def.lanes) {
      lanes[lane.id] = {
        id: lane.id,
        paces: lane.paces,
        geometry: { ...lane.geometry },
        resource: { ...lane.resource },
        towns: lane.towns ? { ...lane.towns } : null,
      };
    }
    const lineLane = this.def.lanes.find((l) => l.geometry.kind === "line");
    return {
      mapId: this.id,
      canvasWidth: board.canvasWidth,
      canvasHeight: board.canvasHeight,
      playerCapital: { ...board.playerCapital },
      enemyCapital: { ...board.enemyCapital },
      capitalRadius: board.capitalRadius,
      fortDistancePaces: this.def.forts.distancePaces,
      paceRulerLaneId: (lineLane && lineLane.id) || this.def.lanes[0].id,
      laneIds: this.laneIds(),
      lanes,
    };
  }

  /**
   * Terrain features for this map.
   * Pass `{ forts: false }` to omit generated side forts.
   */
  features(opts = {}) {
    const layout = this.def.features.map((f) => ({
      ...f,
      sublanes: f.sublanes.slice(),
    }));
    if (opts.forts === false) return layout;
    return [...layout, ...this.sideForts()];
  }

  /** Side forts for every lane at forts.distancePaces from each keep. */
  sideForts() {
    const half = CONFIG.footprintPaces * 2 * 2; // fortFootprintPaces()
    const dist = this.def.forts.distancePaces;
    const forts = [];
    for (const lane of this.def.lanes) {
      const sublanes = allSublaneIndexes(lane.geometry.sublaneCount);
      forts.push(
        {
          id: `fort-player-${lane.id}`,
          kind: "fort",
          lane: lane.id,
          sublanes: sublanes.slice(),
          centerPaces: dist,
          halfWidthPaces: half,
          sideId: "player",
        },
        {
          id: `fort-enemy-${lane.id}`,
          kind: "fort",
          lane: lane.id,
          sublanes: sublanes.slice(),
          centerPaces: lane.paces - dist,
          halfWidthPaces: half,
          sideId: "enemy",
        },
      );
    }
    return forts;
  }

  /**
   * Town placement specs for the sim.
   * @returns {Array<{ laneId: string, placement: string, count: number }>}
   */
  towns() {
    const out = [];
    for (const lane of this.def.lanes) {
      if (!lane.towns) continue;
      out.push({
        laneId: lane.id,
        placement: lane.towns.placement,
        count: lane.towns.count,
      });
    }
    return out;
  }

  /** Lane id that hosts towns, or null. */
  townLaneId() {
    const t = this.towns()[0];
    return t ? t.laneId : null;
  }

  /**
   * Merge global CONFIG defaults ← map.config ← lobby match options.
   * Returns knobs the sim/lobby care about (does not clone all of CONFIG).
   */
  mergedConfig(matchOptions = {}) {
    const mapCfg = this.def.config || {};
    const opts = matchOptions && typeof matchOptions === "object" ? matchOptions : {};

    const fogDefault = mapCfg.fogEnabled != null ? Boolean(mapCfg.fogEnabled) : true;
    const fortsDefault = mapCfg.fortsEnabled != null ? Boolean(mapCfg.fortsEnabled) : true;
    const baseDefault = mapCfg.baseIncome != null && Number.isFinite(Number(mapCfg.baseIncome))
      ? Number(mapCfg.baseIncome)
      : mapCfg.baseGps != null && Number.isFinite(Number(mapCfg.baseGps))
        ? Number(mapCfg.baseGps)
        : CONFIG.baseIncome;

    return {
      mapId: this.id,
      fogEnabled: opts.fogEnabled != null ? Boolean(opts.fogEnabled) : fogDefault,
      fortsEnabled: opts.fortsEnabled != null ? Boolean(opts.fortsEnabled) : fortsDefault,
      baseGps: opts.baseGps != null && Number.isFinite(Number(opts.baseGps))
        ? Number(opts.baseGps)
        : opts.baseIncome != null && Number.isFinite(Number(opts.baseIncome))
          ? Number(opts.baseIncome)
          : baseDefault,
      speed: opts.speed != null ? opts.speed : (mapCfg.speed != null ? mapCfg.speed : 1),
    };
  }

  /** Optional special-rule hook; classic maps no-op. */
  applyRules(_sim) {
    // Reserved for future coded maps.
  }

  /** Compact lane/board summary for client snapshots. */
  snapshotMeta() {
    return {
      id: this.id,
      label: this.label,
      board: {
        canvasWidth: this.def.board.canvasWidth,
        canvasHeight: this.def.board.canvasHeight,
        playerCapital: { ...this.def.board.playerCapital },
        enemyCapital: { ...this.def.board.enemyCapital },
        capitalRadius: this.def.board.capitalRadius,
      },
      fortDistancePaces: this.def.forts.distancePaces,
      lanes: this.def.lanes.map((lane) => ({
        id: lane.id,
        paces: lane.paces,
        geometry: { ...lane.geometry },
        resource: { ...lane.resource },
        towns: lane.towns ? { ...lane.towns } : null,
      })),
      rules: { ...this.def.rules },
    };
  }

  toLobbyPreset() {
    return { id: this.id, label: this.label };
  }
}
