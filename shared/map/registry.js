import { CONFIG } from "../config.js";
import { GameMap } from "./GameMap.js";

/** @type {Map<string, GameMap>} */
const _maps = new Map();

export function registerMap(map) {
  if (!(map instanceof GameMap)) {
    throw new Error("registerMap expects a GameMap instance");
  }
  _maps.set(map.id, map);
  return map;
}

export function getMap(mapId) {
  const id = mapId || CONFIG.defaultMapId || "default";
  return _maps.get(id) || _maps.get(CONFIG.defaultMapId) || _maps.get("default") || null;
}

export function mapIds() {
  return [..._maps.keys()];
}

/** Lobby / API list of { id, label }. */
export function mapLobbyPresets() {
  return mapIds().map((id) => {
    const m = _maps.get(id);
    return m ? m.toLobbyPreset() : { id, label: id };
  });
}

/**
 * Register from a plain definition (future map-making tools).
 * @param {object} definition
 */
export function registerMapDefinition(definition) {
  return registerMap(GameMap.fromDefinition(definition));
}
