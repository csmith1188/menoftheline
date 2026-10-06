import { CONFIG } from "./config.js";
import { MAP_PRESETS, mapPresetIds } from "./maps.js";

/** Allowed match speed multipliers (shared by bot settings and custom lobbies). */
export const MATCH_SPEEDS = [0.25, 0.5, 1, 1.5, 2];

/** Inclusive bounds for custom lobby base gold/sec. */
export const BASE_GPS_MIN = 0;
export const BASE_GPS_MAX = 50;

export function defaultMatchOptions() {
  return {
    speed: 1,
    fogEnabled: true,
    mapId: CONFIG.defaultMapId || "default",
    fortsEnabled: true,
    baseGps: CONFIG.baseIncome,
  };
}

function asBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).toLowerCase();
  if (s === "1" || s === "true" || s === "on" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "off" || s === "no") return false;
  return fallback;
}

/**
 * Normalize lobby / intent match options. Unknown values fall back to defaults.
 * Accepts form bodies or JSON-ish objects.
 */
export function normalizeMatchOptions(raw = {}) {
  const defaults = defaultMatchOptions();
  const src = raw && typeof raw === "object" ? raw : {};

  let speed = Number(src.speed);
  if (!MATCH_SPEEDS.includes(speed)) speed = defaults.speed;

  const mapIds = mapPresetIds();
  let mapId = String(src.mapId || src.map || defaults.mapId);
  if (!mapIds.includes(mapId)) mapId = defaults.mapId;

  let baseGps = Number(src.baseGps != null ? src.baseGps : src.baseIncome);
  if (!Number.isFinite(baseGps)) baseGps = defaults.baseGps;
  baseGps = Math.round(baseGps);
  if (baseGps < BASE_GPS_MIN) baseGps = BASE_GPS_MIN;
  if (baseGps > BASE_GPS_MAX) baseGps = BASE_GPS_MAX;

  return {
    speed,
    fogEnabled: asBool(src.fogEnabled != null ? src.fogEnabled : src.fog, defaults.fogEnabled),
    mapId,
    fortsEnabled: asBool(
      src.fortsEnabled != null ? src.fortsEnabled : src.forts,
      defaults.fortsEnabled,
    ),
    baseGps,
  };
}

/** Short labels for Open Games / lobby UI. */
export function matchOptionsSummary(opts) {
  const o = normalizeMatchOptions(opts);
  const mapLabel = (MAP_PRESETS[o.mapId] && MAP_PRESETS[o.mapId].label) || o.mapId;
  return {
    ...o,
    mapLabel,
    speedLabel: `${o.speed}×`,
    fogLabel: o.fogEnabled ? "Fog on" : "Fog off",
    fortsLabel: o.fortsEnabled ? "Forts on" : "Forts off",
    baseGpsLabel: `${o.baseGps} GPS`,
  };
}
