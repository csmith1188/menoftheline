/**
 * Compatibility shim for named map presets.
 * Prefer `shared/map/` (GameMap + registry) for new code.
 */
import { CONFIG } from "./config.js";
import {
  getMap,
  mapIds,
  mapLobbyPresets,
} from "./map/index.js";

function buildMapPresets() {
  const out = {};
  for (const id of mapIds()) {
    const map = getMap(id);
    if (!map) continue;
    out[id] = {
      id: map.id,
      label: map.label,
      layout: map.def.features,
    };
  }
  return out;
}

/** @deprecated Prefer getMap(id) / mapLobbyPresets() */
export const MAP_PRESETS = buildMapPresets();

/**
 * Resolve a map id into a full feature list.
 * Pass `{ forts: false }` to omit side forts (custom lobbies).
 */
export function resolveMapFeatures(mapId, opts = {}) {
  const map = getMap(mapId) || getMap(CONFIG.defaultMapId);
  if (!map) return [];
  return map.features(opts);
}

/** List of known map preset ids. */
export function mapPresetIds() {
  return mapIds();
}

export { mapLobbyPresets, getMap };
