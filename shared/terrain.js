import { CONFIG } from "./config.js";
import { resolveMapFeatures } from "./maps.js";
import {
  fortColorHalfPaces,
  pacesFromKeepOf,
  Path,
  terrainFootprintPaces,
  troopLaneT,
} from "./path.js";
import { mobilityClass, unitStats } from "./units.js";

/** Kinds that block line of sight (fort is asymmetric). */
const LOS_KINDS = new Set(["hill", "peak", "woods", "fort"]);

/** Emoji labels for client draw. */
export const TERRAIN_EMOJI = {
  hill: "⛰️",
  woods: "🌲",
  river: "🌊",
  peak: "🗻",
  bridge: "🌉",
  fort: "🏰",
};

/** Soft tints for row strokes (client). */
export const TERRAIN_TINT = {
  hill: "rgba(140, 120, 70, 0.55)",
  woods: "rgba(50, 100, 55, 0.55)",
  river: "rgba(50, 110, 160, 0.55)",
  peak: "rgba(110, 110, 120, 0.6)",
  bridge: "rgba(130, 95, 60, 0.5)",
  fort: "rgba(90, 90, 90, 0.35)",
};

let _cachedMapKey = null;
let _cachedFeatures = null;
/** Open LOS segments by map key → "lane:sublane" → segments (static geometry). */
let _openSegCache = new Map();
/** Unfogged open-segment regions by map key (static geometry, fogged: false). */
let _openRegionCache = new Map();

function emptyTerrainFx() {
  return {
    pontoonIds: new Set(),
    losCancel: { player: new Set(), enemy: new Set() },
  };
}

let _terrainFx = emptyTerrainFx();
/** Per-room map resolve knobs (installed with terrain FX while a sim runs). */
let _mapOpts = { forts: true };

function mapCacheKey(mapId, forts) {
  const id = mapId || CONFIG.defaultMapId;
  return forts === false ? `${id}:noforts` : id;
}

/** Match overlay: pontoon rivers and Engineer LOS cancel. */
export function setTerrainFx(fx) {
  _terrainFx = fx || emptyTerrainFx();
}

/** Install map resolve options for the active room (forts on/off). */
export function setMapOpts(opts = {}) {
  _mapOpts = { forts: opts.forts !== false };
}

export function getMapOpts() {
  return { ..._mapOpts };
}

export function getTerrainFx() {
  return _terrainFx;
}

/** Build pontoon / LOS-cancel overlay without touching process-global FX. */
export function computeTerrainFx(troopsBySide, mapId) {
  const pontoonIds = new Set();
  const losCancel = { player: new Set(), enemy: new Set() };
  const features = featuresOnMap(mapId);
  const sides = ["player", "enemy"];
  for (let s = 0; s < sides.length; s += 1) {
    const sideId = sides[s];
    const list = living(troopsBySide && troopsBySide[sideId]);
    for (let i = 0; i < list.length; i += 1) {
      const unit = list[i];
      if (unit.variant !== "engineer") continue;
      for (let f = 0; f < features.length; f += 1) {
        const feature = features[f];
        if (!auraOverlapsFeature(unit, feature, mapId)) continue;
        losCancel[sideId].add(feature.id);
        if (feature.kind === "river") pontoonIds.add(feature.id);
      }
    }
  }
  return { pontoonIds, losCancel };
}

/**
 * Engineer officer-aura reach in paces (doubled while on a hill or peak).
 * Other units fall back to the shared officer restore reach.
 */
export function engineerAuraPaces(unit, mapId) {
  const base = CONFIG.officerRestorePaces;
  if (!unit || unit.variant !== "engineer") return base;
  const under = featuresUnder(unit, mapId);
  for (let i = 0; i < under.length; i += 1) {
    const kind = under[i].kind;
    if (kind === "hill" || kind === "peak") {
      return base * CONFIG.engineerElevationAuraFactor;
    }
  }
  return base;
}

/** True when an Engineer aura overlaps this feature's footprint. */
export function auraOverlapsFeature(unit, feature, mapId) {
  if (!unit || !feature || unit.lane !== feature.lane || unit.hp <= 0) return false;
  const paces = playerPacesOf(unit);
  if (paces == null) return false;
  const reach = engineerAuraPaces(unit, mapId);
  const { minPaces, maxPaces } = featureInterval(feature);
  return paces + reach >= minPaces && paces - reach <= maxPaces;
}

/** Rebuild process-global pontoon / LOS-cancel overlay from living Engineers. */
export function refreshTerrainFx(troopsBySide, mapId) {
  _terrainFx = computeTerrainFx(troopsBySide, mapId);
  return _terrainFx;
}

function riverIsPontoon(feature) {
  return Boolean(feature && feature.kind === "river" && _terrainFx.pontoonIds.has(feature.id));
}

function sideCancelsLos(viewerSideId, feature) {
  const set = _terrainFx.losCancel && _terrainFx.losCancel[viewerSideId];
  return Boolean(set && feature && set.has(feature.id));
}

function featureOpenForSide(viewerSideId, feature, troopsBySide, laneFriends) {
  return sideOccupiesFeature(viewerSideId, feature, troopsBySide, laneFriends)
    || sideCancelsLos(viewerSideId, feature);
}

/** Active features for a map id (cached per id + forts flag). */
export function featuresOnMap(mapId) {
  const id = mapId || CONFIG.defaultMapId;
  const forts = _mapOpts.forts !== false;
  const key = mapCacheKey(id, forts);
  if (_cachedMapKey !== key || !_cachedFeatures) {
    _cachedMapKey = key;
    _cachedFeatures = resolveMapFeatures(id, { forts });
  }
  return _cachedFeatures;
}

/** Clear feature cache (tests). */
export function clearTerrainCache() {
  _cachedMapKey = null;
  _cachedFeatures = null;
  _openSegCache = new Map();
  _openRegionCache = new Map();
  _terrainFx = emptyTerrainFx();
  _mapOpts = { forts: true };
}

/** Footprint interval in player-keep paces. */
export function featureInterval(feature) {
  const half = feature.halfWidthPaces != null ? feature.halfWidthPaces : terrainFootprintPaces();
  return {
    minPaces: feature.centerPaces - half,
    maxPaces: feature.centerPaces + half,
    centerPaces: feature.centerPaces,
    halfWidthPaces: half,
  };
}

/** Paces from the player keep along the unit's lane. */
export function playerPacesOf(unit) {
  if (!unit || !unit.lane) return null;
  const total = Path.lanePaces(unit.lane);
  return troopLaneT(unit) * total;
}

/** Unit type key for mobility (variant preferred). */
function unitTypeKey(unit) {
  if (!unit) return "troop";
  return unit.variant || unit.type || "troop";
}

function living(list) {
  const out = [];
  const arr = list || [];
  for (let i = 0; i < arr.length; i += 1) {
    const u = arr[i];
    if (u && u.hp > 0) out.push(u);
  }
  return out;
}

/** Living units split by lane, built once per snapshot or sim step. */
export function livingByLane(list) {
  const top = [];
  const bottom = [];
  const all = [];
  const arr = list || [];
  for (let i = 0; i < arr.length; i += 1) {
    const u = arr[i];
    if (!u || u.hp <= 0) continue;
    all.push(u);
    if (u.lane === "top") top.push(u);
    else if (u.lane === "bottom") bottom.push(u);
  }
  return { top, bottom, all };
}

function sideIdOf(unit) {
  return unit && unit.side && unit.side.id;
}

/** True when unit centerline is on this feature's footprint. */
export function onTerrain(unit, feature) {
  if (!unit || !feature || unit.lane !== feature.lane) return false;
  if (unit.sublane == null || feature.sublanes.indexOf(unit.sublane) < 0) return false;
  const paces = playerPacesOf(unit);
  if (paces == null) return false;
  const { minPaces, maxPaces } = featureInterval(feature);
  return paces >= minPaces && paces <= maxPaces;
}

/** Features under a unit. */
export function featuresUnder(unit, mapId) {
  const features = featuresOnMap(mapId);
  const hit = [];
  for (let i = 0; i < features.length; i += 1) {
    if (onTerrain(unit, features[i])) hit.push(features[i]);
  }
  return hit;
}

/** Features covering a lane/sublane/paces sample. */
export function featuresAt(lane, sublane, paces, mapId) {
  const features = featuresOnMap(mapId);
  const hit = [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (f.lane !== lane || f.sublanes.indexOf(sublane) < 0) continue;
    const { minPaces, maxPaces } = featureInterval(f);
    if (paces >= minPaces && paces <= maxPaces) hit.push(f);
  }
  return hit;
}

/**
 * Hard occupancy check for a type at a sample point.
 * Artillery cannot enter river/peak; cavalry cannot enter peak.
 */
export function canOccupy(unitType, lane, sublane, paces, mapId) {
  const mob = mobilityClass(unitType);
  const at = featuresAt(lane, sublane, paces, mapId);
  for (let i = 0; i < at.length; i += 1) {
    const kind = at[i].kind;
    if (kind === "peak" && mob !== "infantry") return false;
    if (kind === "river" && mob === "artillery" && !riverIsPontoon(at[i])) return false;
  }
  return true;
}

/** True when a unit body can stand where it is / would be. */
export function unitCanOccupy(unit, mapId) {
  if (!unit || !unit.lane) return true;
  const paces = playerPacesOf(unit);
  if (paces == null) return true;
  return canOccupy(unitTypeKey(unit), unit.lane, unit.sublane, paces, mapId);
}

/**
 * Half speed while this unit's center is in an enemy fort's colored band.
 * Friendlies are not slowed by their own fort. Applies even to units that
 * ignore other terrain slows.
 */
function enemyFortColorFactor(unit, mapId) {
  const sideId = sideIdOf(unit);
  const paces = playerPacesOf(unit);
  if (!sideId || paces == null || unit.sublane == null) return 1;
  const half = fortColorHalfPaces();
  const features = featuresOnMap(mapId);
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (f.kind !== "fort" || f.lane !== unit.lane) continue;
    if (!f.sideId || f.sideId === sideId) continue;
    if (f.sublanes.indexOf(unit.sublane) < 0) continue;
    if (Math.abs(paces - f.centerPaces) <= half) return CONFIG.fortColorSlow;
  }
  return 1;
}

/**
 * Combined move-speed multiplier from overlapping terrain.
 * Hill slope is relative to the unit's own keep. `backward` flips it
 * for a step toward that keep (retreat, fall back, charge reverse, peel).
 * An enemy fort's colored band slows on top of that.
 */
export function moveSpeedFactor(unit, mapId, backward = false) {
  if (!unit || !unit.lane) return 1;
  const fortSlow = enemyFortColorFactor(unit, mapId);
  const stats = unitStats(unitTypeKey(unit));
  if (stats && stats.ignoreTerrainSlow) return fortSlow;
  const under = featuresUnder(unit, mapId);
  if (!under.length) return fortSlow;
  const mob = mobilityClass(unitTypeKey(unit));
  const sideId = sideIdOf(unit);
  const paces = playerPacesOf(unit);
  let factor = 1;
  for (let i = 0; i < under.length; i += 1) {
    const f = under[i];
    if (f.kind === "woods") {
      factor *= CONFIG.woodsSlow;
    } else if (f.kind === "river") {
      if (riverIsPontoon(f)) continue;
      if (mob === "infantry") factor *= CONFIG.riverInfantrySlow;
      else if (mob === "cavalry") factor *= CONFIG.riverCavalrySlow;
    } else if (f.kind === "peak") {
      if (mob === "infantry") factor *= CONFIG.peakSlow;
    } else if (f.kind === "hill" && paces != null && sideId) {
      const center = f.centerPaces;
      const fromOwn =
        sideId === "player" ? paces : Path.lanePaces(unit.lane) - paces;
      const centerFromOwn =
        sideId === "player" ? center : Path.lanePaces(unit.lane) - center;
      // Advancing away from own keep: before the crest is uphill.
      // A step back toward own keep reverses that slope.
      const climbing = backward
        ? fromOwn > centerFromOwn
        : fromOwn < centerFromOwn;
      const descending = backward
        ? fromOwn < centerFromOwn
        : fromOwn > centerFromOwn;
      if (climbing) factor *= 1 - CONFIG.hillSlope;
      else if (descending) factor *= 1 + CONFIG.hillSlope;
    }
  }
  return factor * fortSlow;
}

/** Shoot range multiplier (hill +20%). */
export function shootRangeFactor(unit, mapId) {
  const bonus = 1 + CONFIG.hillRangeBonus;
  const under = featuresUnder(unit, mapId);
  for (let i = 0; i < under.length; i += 1) {
    if (under[i].kind === "hill") return bonus;
  }
  const allies = unit && unit.side && unit.side.troops;
  if (!allies || !unit.lane) return 1;
  const selfPaces = playerPacesOf(unit);
  if (selfPaces == null) return 1;
  for (let i = 0; i < allies.length; i += 1) {
    const source = allies[i];
    if (!source || source.hp <= 0 || source.variant !== "engineer") continue;
    if (source.lane !== unit.lane) continue;
    const srcPaces = playerPacesOf(source);
    if (srcPaces == null) continue;
    if (Math.abs(srcPaces - selfPaces) > engineerAuraPaces(source, mapId)) continue;
    const hills = featuresUnder(source, mapId);
    for (let h = 0; h < hills.length; h += 1) {
      if (hills[h].kind === "hill") return bonus;
    }
  }
  return 1;
}

/**
 * Cover fractions from standing on woods, a peak, a hill, or a friendly fort.
 * Each applies only when the attacker is not also inside that same footprint.
 * Fort cover is only for the side that owns the fort.
 */
export function terrainCoverParts(defender, attacker, mapId) {
  const parts = [];
  if (!defender) return parts;
  const under = featuresUnder(defender, mapId);
  const sideId = sideIdOf(defender);
  let woods = false;
  let peak = false;
  let hill = false;
  let fort = false;
  for (let i = 0; i < under.length; i += 1) {
    const f = under[i];
    if (attacker && onTerrain(attacker, f)) continue;
    if (f.kind === "woods") woods = true;
    else if (f.kind === "peak") peak = true;
    else if (f.kind === "hill") hill = true;
    else if (f.kind === "fort" && f.sideId && f.sideId === sideId) fort = true;
  }
  if (woods && CONFIG.woodsCover > 0) parts.push(CONFIG.woodsCover);
  if (peak && CONFIG.peakCover > 0) parts.push(CONFIG.peakCover);
  if (hill && CONFIG.hillCover > 0) parts.push(CONFIG.hillCover);
  if (fort && CONFIG.quarterArmor > 0) parts.push(CONFIG.quarterArmor);
  return parts;
}

/** Product of terrain-cover factors (1 when the unit has none). */
export function terrainCoverFactor(defender, attacker, mapId) {
  const parts = terrainCoverParts(defender, attacker, mapId);
  let factor = 1;
  for (let i = 0; i < parts.length; i += 1) factor *= 1 - parts[i];
  return factor;
}

/** True when woods, peak, hill, or friendly-fort cover applies. */
export function terrainCover(defender, attacker, mapId) {
  return terrainCoverFactor(defender, attacker, mapId) < 1;
}

/** Does this feature block LOS for this viewer side? */
export function featureBlocksLos(feature, viewerSideId) {
  if (!feature || !LOS_KINDS.has(feature.kind)) return false;
  if (feature.kind === "fort") {
    return feature.sideId !== viewerSideId;
  }
  return true;
}

/** Viewer has a living unit on this feature. */
export function sideOccupiesFeature(viewerSideId, feature, troopsBySide, laneFriends) {
  const list = laneFriends || living(troopsBySide && troopsBySide[viewerSideId]);
  for (let i = 0; i < list.length; i += 1) {
    const unit = list[i];
    if (!laneFriends && unit.lane !== feature.lane) continue;
    if (onTerrain(unit, feature)) return true;
  }
  return false;
}

/**
 * Open interval (lo, hi) in player paces intersects feature footprint
 * (strictly between endpoints — units on the footprint use other rules).
 */
function intervalBlocksBetween(lo, hi, feature) {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const { minPaces, maxPaces } = featureInterval(feature);
  // Intersect open interval (a,b) with [min,max]
  const left = Math.max(a, minPaces);
  const right = Math.min(b, maxPaces);
  // Need positive overlap strictly inside (a,b)
  if (!(right > left)) return false;
  // If the only overlap is exactly at an endpoint of (a,b), ignore
  if (right <= a || left >= b) return false;
  // Require some interior overlap
  return right - left > 1e-9 && left < b && right > a;
}

/**
 * True when two living bodies are in melee contact (same lane, within
 * body radii + meleeSlack). Prefers Unit.collidingEnemy when present.
 */
export function unitsInMeleeContact(a, b) {
  if (!a || !b || a.hp <= 0 || b.hp <= 0) return false;
  if (a.lane == null || b.lane == null || a.lane !== b.lane) return false;
  if (typeof a.collidingEnemy === "function") {
    const hit = a.collidingEnemy([b]);
    return Boolean(hit && (b.fightsMelee !== false) && (a.fightsMelee !== false));
  }
  if (typeof b.collidingEnemy === "function") {
    const hit = b.collidingEnemy([a]);
    return Boolean(hit && (a.fightsMelee !== false) && (b.fightsMelee !== false));
  }
  if (a.x == null || b.x == null) return false;
  const ar = typeof a.bodyRadius === "function" ? a.bodyRadius() : (a.radius || 10);
  const br = typeof b.bodyRadius === "function" ? b.bodyRadius() : (b.radius || 10);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const reach = ar + br + (CONFIG.meleeSlack || 0);
  return dx * dx + dy * dy <= reach * reach;
}

/** True when any living friendly is in melee with this enemy. */
export function inMeleeWithViewer(viewerSideId, enemy, troopsBySide, friends) {
  const list = friends || living(troopsBySide && troopsBySide[viewerSideId]);
  for (let i = 0; i < list.length; i += 1) {
    if (unitsInMeleeContact(list[i], enemy)) return true;
  }
  return false;
}

/**
 * Ranged LOS from observer to target for viewerSideId.
 * Cross-lane: only outbound leg keep → target on target lane.
 * Same-lane: between observer and target paces on target's lane/row.
 * Keep targets count as the observer's lane/row, so LOS is observer → keep
 * (not home-keep → enemy-keep across the whole lane).
 * Units standing on a terrain footprint remain shootable (that footprint
 * does not block shots *to* them); footprints still block shots past them.
 */
export function hasShotLos(observer, target, viewerSideId, troopsBySide, mapId) {
  if (!target) return false;
  const features = featuresOnMap(mapId);
  const obsSide = observer && (sideIdOf(observer) || (observer.id === "player" || observer.id === "enemy" ? observer.id : null));

  let targetLane = target.lane;
  let targetSublane = target.sublane;
  let targetPaces = playerPacesOf(target);
  const isKeepTarget = target.capitalHP !== undefined || (target.capital && target.id);

  if (isKeepTarget) {
    // Keep sits on every row; for LOS it is this shooter's lane/row.
    targetLane = (observer && observer.lane) || "top";
    targetSublane = observer && observer.sublane != null ? observer.sublane : 0;
    const keepId = target.id;
    targetPaces = keepId === "player" ? 0 : Path.lanePaces(targetLane);
  }

  if (targetLane == null || targetPaces == null) return true;

  let fromPaces;
  // Unit→keep uses the same along-lane segment as unit→unit.
  const sameLane = observer && observer.lane === targetLane;

  if (sameLane) {
    fromPaces = playerPacesOf(observer);
    if (fromPaces == null) return true;
  } else {
    const keepSide = viewerSideId || obsSide;
    fromPaces = keepSide === "player" ? 0 : Path.lanePaces(targetLane);
  }

  // Guerilla stealth: no shot unless melee, recent fire, within stealth
  // paces, or the viewer occupies (or an Engineer opens) their woods.
  if (target.hp !== undefined && guerrillaConcealedFrom(viewerSideId, target, troopsBySide, mapId, true)) {
    return false;
  }

  const friendsOnLane = livingByLane(troopsBySide && troopsBySide[viewerSideId])[targetLane] || [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (f.lane !== targetLane) continue;
    if (targetSublane != null && f.sublanes.indexOf(targetSublane) < 0) continue;
    if (!featureBlocksLos(f, viewerSideId)) continue;
    if (featureOpenForSide(viewerSideId, f, troopsBySide, friendsOnLane)) continue;
    // Shooters can always engage a unit whose centerline is on this footprint.
    if (target.hp !== undefined && onTerrain(target, f)) continue;
    if (intervalBlocksBetween(fromPaces, targetPaces, f)) return false;
  }
  return true;
}

/** Rivers/bridges never bound LOS crest segments (they do not block sight). */
function splitsLosSegments(feature) {
  return feature && feature.kind !== "river" && feature.kind !== "bridge";
}

/**
 * Merged terrain footprints on one row, with the features that form each
 * blob's near/far edges (player-keep paces). Rivers and bridges are omitted
 * so they do not split crest / fog LOS segments.
 */
function mergedTerrainBlobs(lane, sublane, mapId) {
  const features = featuresOnMap(mapId);
  const total = Path.lanePaces(lane);
  const cuts = [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (f.lane !== lane || f.sublanes.indexOf(sublane) < 0) continue;
    if (!splitsLosSegments(f)) continue;
    const { minPaces, maxPaces } = featureInterval(f);
    cuts.push({
      feature: f,
      min: Math.max(0, minPaces),
      max: Math.min(total, maxPaces),
    });
  }
  cuts.sort((a, b) => a.min - b.min || a.max - b.max);
  const merged = [];
  for (let i = 0; i < cuts.length; i += 1) {
    const c = cuts[i];
    if (!merged.length || c.min > merged[merged.length - 1].max) {
      merged.push({
        min: c.min,
        max: c.max,
        startFeature: c.feature,
        endFeature: c.feature,
      });
      continue;
    }
    const blob = merged[merged.length - 1];
    if (c.min < blob.min || (c.min === blob.min && c.feature === blob.startFeature)) {
      blob.startFeature = c.feature;
      blob.min = Math.min(blob.min, c.min);
    }
    if (c.max >= blob.max) {
      blob.max = c.max;
      blob.endFeature = c.feature;
    }
  }
  return merged;
}

/**
 * Open pace segments on a row between keeps and LOS-relevant terrain
 * (hills, woods, peaks, forts). Rivers and bridges are skipped.
 * `leftFeature` / `rightFeature` bound the gap (null at a keep).
 */
export function openSegmentsOnRow(lane, sublane, mapId) {
  const id = mapId || CONFIG.defaultMapId;
  const cacheId = mapCacheKey(id, _mapOpts.forts !== false);
  let byRow = _openSegCache.get(cacheId);
  if (!byRow) {
    byRow = new Map();
    _openSegCache.set(cacheId, byRow);
  }
  const key = `${lane}:${sublane}`;
  let segments = byRow.get(key);
  if (segments) return segments;

  const total = Path.lanePaces(lane);
  const merged = mergedTerrainBlobs(lane, sublane, id);
  segments = [];
  let cursor = 0;
  let leftFeature = null;
  for (let i = 0; i < merged.length; i += 1) {
    const blob = merged[i];
    if (blob.min > cursor + 1e-6) {
      segments.push({
        lane,
        sublane,
        minPaces: cursor,
        maxPaces: blob.min,
        leftFeature,
        rightFeature: blob.startFeature,
      });
    }
    cursor = Math.max(cursor, blob.max);
    leftFeature = blob.endFeature;
  }
  if (cursor < total - 1e-6) {
    segments.push({
      lane,
      sublane,
      minPaces: cursor,
      maxPaces: total,
      leftFeature,
      rightFeature: null,
    });
  }
  byRow.set(key, segments);
  return segments;
}

/** Open segment on this row containing `paces`, or null when on a footprint. */
export function openSegmentAt(lane, sublane, paces, mapId) {
  if (paces == null) return null;
  const segments = openSegmentsOnRow(lane, sublane, mapId);
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    if (paces >= s.minPaces - 1e-9 && paces <= s.maxPaces + 1e-9) return s;
  }
  return null;
}

/**
 * True when a friendly at `paces` crests this open segment: past the near
 * LOS-blocking centerline and not past the far terrain footprint.
 * Same-lane units on any row count; pace windows are lane-absolute.
 */
export function crestsOpenSegment(viewerSideId, paces, segment) {
  if (!segment || paces == null) return false;
  const left = segment.leftFeature;
  const right = segment.rightFeature;
  if (viewerSideId === "enemy") {
    // Enemy advances toward lower player-paces.
    if (right) {
      if (!(paces < right.centerPaces)) return false;
    }
    if (left) {
      const { maxPaces } = featureInterval(left);
      if (!(paces > maxPaces)) return false;
    }
    return true;
  }
  // Player (default): advance toward higher player-paces.
  if (left) {
    if (!(paces > left.centerPaces)) return false;
  }
  if (right) {
    const { minPaces } = featureInterval(right);
    if (!(paces < minPaces)) return false;
  }
  return true;
}

/** Any living friendly on this lane sits in the crest window for `segment`. */
export function sideCrestsSegment(viewerSideId, segment, troopsBySide) {
  if (!segment) return false;
  const friends = living(troopsBySide && troopsBySide[viewerSideId]);
  for (let i = 0; i < friends.length; i += 1) {
    const u = friends[i];
    if (!u || u.lane !== segment.lane) continue;
    const paces = playerPacesOf(u);
    if (crestsOpenSegment(viewerSideId, paces, segment)) return true;
  }
  return false;
}

/** Open fog region containing paces on this row, or null when on a footprint. */
function fogRegionAt(fogRegions, lane, sublane, paces) {
  if (!fogRegions || paces == null || lane == null || sublane == null) return null;
  for (let i = 0; i < fogRegions.length; i += 1) {
    const r = fogRegions[i];
    if (r.lane !== lane || r.sublane !== sublane) continue;
    if (paces >= r.minPaces - 1e-9 && paces <= r.maxPaces + 1e-9) return r;
  }
  return null;
}

/**
 * Fog visibility of an enemy unit for viewerSideId.
 * Melee contact always reveals. Guerillas add stealth and woods hide.
 * Other units in woods use ordinary fog/LOS. Open segments are visible when
 * any same-lane friendly crests them. Units on hill/peak/fort footprints
 * stay visible only when LOS reaches that footprint.
 *
 * Shot LOS is fully covered by canSeePace (same-lane friends + keep):
 * cross-lane friend checks use the same keep→target segment as the keep probe.
 * Pass `fogRegions` from snapshotTerrain to reuse open-segment visibility.
 */
export function isEnemyVisible(viewerSideId, enemy, troopsBySide, mapId, fogRegions = null, friends = null) {
  if (!enemy || enemy.hp <= 0) return false;

  if (inMeleeWithViewer(viewerSideId, enemy, troopsBySide, friends)) return true;
  if (guerrillaConcealedFrom(viewerSideId, enemy, troopsBySide, mapId)) return false;

  const paces = playerPacesOf(enemy);
  if (paces == null || enemy.lane == null || enemy.sublane == null) return true;
  if (fogRegions) {
    const region = fogRegionAt(fogRegions, enemy.lane, enemy.sublane, paces);
    if (region) return !region.fogged;
  }
  return canSeePace(viewerSideId, enemy.lane, enemy.sublane, paces, troopsBySide, mapId);
}

/**
 * Guerillas stay concealed until melee (vision), a recent shot, a same-lane
 * viewer within stealth paces, or the viewer opens woods they occupy.
 * `forShot` keeps woods closed even when a friend is in melee, so only
 * occupants (or Engineers) can fire into those woods.
 */
function guerrillaConcealedFrom(viewerSideId, enemy, troopsBySide, mapId, forShot = false) {
  if (!enemy || enemy.variant !== "guerrilla") return false;
  if (!forShot && inMeleeWithViewer(viewerSideId, enemy, troopsBySide)) return false;
  if (guerrillaShotRevealed(enemy)) return false;
  const under = featuresUnder(enemy, mapId);
  for (let i = 0; i < under.length; i += 1) {
    if (under[i].kind !== "woods") continue;
    if (!featureOpenForSide(viewerSideId, under[i], troopsBySide)) return true;
  }
  return !guerrillaNearViewer(viewerSideId, enemy, troopsBySide);
}

function guerrillaShotRevealed(enemy) {
  const sim = enemy.side && enemy.side.sim;
  if (!sim || enemy.lastShotAt == null) return false;
  return (sim.elapsed - enemy.lastShotAt) <= CONFIG.guerrillaShotRevealSec;
}

function guerrillaNearViewer(viewerSideId, enemy, troopsBySide) {
  const limit = CONFIG.guerrillaStealthPaces;
  const ePaces = playerPacesOf(enemy);
  const friends = living(troopsBySide && troopsBySide[viewerSideId]);
  for (let i = 0; i < friends.length; i += 1) {
    const friend = friends[i];
    if (!friend || friend.lane !== enemy.lane) continue;
    const fp = playerPacesOf(friend);
    if (fp == null || ePaces == null) continue;
    if (Math.abs(fp - ePaces) <= limit) return true;
  }
  return false;
}

/**
 * Feature ids that still block LOS for this viewer (not cancelled by occupying).
 * Used for logic; lane darkening uses fogLaneRegions instead.
 */
export function foggedFeatureIds(viewerSideId, troopsBySide, mapId) {
  const features = featuresOnMap(mapId);
  const dark = [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (!featureBlocksLos(f, viewerSideId)) continue;
    if (featureOpenForSide(viewerSideId, f, troopsBySide)) continue;
    dark.push(f.id);
  }
  return dark;
}

/**
 * True when the viewer can see a sample point on a lane row (player-keep paces).
 * Keep / same-row shot LOS, or any same-lane friendly cresting that open segment.
 */
export function canSeePace(viewerSideId, lane, sublane, paces, troopsBySide, mapId, laneFriends) {
  const total = Path.lanePaces(lane);
  if (!(total > 0) || paces == null) return true;
  const probe = {
    side: { id: "player" },
    lane,
    sublane,
    progress: Math.max(0, Math.min(1, paces / total)),
    hp: 1,
  };
  // Cross-lane observers use the same keep→target segment as keepUnit below.
  // `laneFriends` is the viewer's living units already filtered to this lane.
  const friends = laneFriends || living(troopsBySide && troopsBySide[viewerSideId]);
  for (let i = 0; i < friends.length; i += 1) {
    const friend = friends[i];
    if (!friend || friend.lane !== lane) continue;
    if (hasShotLos(friend, probe, viewerSideId, troopsBySide, mapId)) return true;
  }
  const keepUnit = {
    side: { id: viewerSideId },
    lane,
    sublane,
    progress: 0,
    hp: 1,
  };
  if (hasShotLos(keepUnit, probe, viewerSideId, troopsBySide, mapId)) return true;

  const segment = openSegmentAt(lane, sublane, paces, mapId);
  return sideCrestsSegment(viewerSideId, segment, troopsBySide);
}

/**
 * Open lane segments between keeps and terrain footprints on each row.
 * `fogged` is true when the viewer has no LOS into that segment.
 * Terrain footprints themselves are omitted (never darkened further).
 */
export function fogLaneRegions(viewerSideId, troopsBySide, mapId, friendsByLane) {
  const grouped = friendsByLane || livingByLane(troopsBySide && troopsBySide[viewerSideId]);
  const regions = [];
  const lanes = ["top", "bottom"];
  for (let li = 0; li < lanes.length; li += 1) {
    const lane = lanes[li];
    const laneFriends = grouped[lane] || [];
    const count = Path.sublaneCount(lane);
    for (let sub = 0; sub < count; sub += 1) {
      const segments = openSegmentsOnRow(lane, sub, mapId);
      for (let i = 0; i < segments.length; i += 1) {
        const s = segments[i];
        const mid = (s.minPaces + s.maxPaces) / 2;
        regions.push({
          lane: s.lane,
          sublane: s.sublane,
          minPaces: s.minPaces,
          maxPaces: s.maxPaces,
          fogged: !canSeePace(viewerSideId, lane, sub, mid, troopsBySide, mapId, laneFriends),
        });
      }
    }
  }
  return regions;
}

/** Open lane segments with fogged forced off. Cached per map + forts. */
function openFogRegions(mapId) {
  const key = mapCacheKey(mapId, getMapOpts().forts);
  const hit = _openRegionCache.get(key);
  if (hit) return hit;
  const regions = [];
  const lanes = ["top", "bottom"];
  for (let li = 0; li < lanes.length; li += 1) {
    const lane = lanes[li];
    const count = Path.sublaneCount(lane);
    for (let sub = 0; sub < count; sub += 1) {
      const segments = openSegmentsOnRow(lane, sub, mapId);
      for (let i = 0; i < segments.length; i += 1) {
        const s = segments[i];
        regions.push({
          lane: s.lane,
          sublane: s.sublane,
          minPaces: s.minPaces,
          maxPaces: s.maxPaces,
          fogged: false,
        });
      }
    }
  }
  _openRegionCache.set(key, regions);
  return regions;
}

/** Feature list copied for clients. `pontoon` flips when an engineer opens a river. */
export function serializeMapFeatures(mapId, pontoonIds) {
  const ids = pontoonIds || new Set();
  return featuresOnMap(mapId).map((f) => ({
    id: f.id,
    kind: f.kind,
    lane: f.lane,
    sublanes: f.sublanes.slice(),
    centerPaces: f.centerPaces,
    halfWidthPaces: f.halfWidthPaces != null ? f.halfWidthPaces : terrainFootprintPaces(),
    sideId: f.sideId || null,
    pontoon: f.kind === "river" && ids.has(f.id),
  }));
}

/**
 * Clamp a proposed player-pace sample so a unit of the given type does not
 * enter impassable terrain when moving from `fromPaces` toward `toPaces`.
 */
export function clampPaceMove(unitType, lane, sublane, fromPaces, toPaces, mapId) {
  if (fromPaces == null || toPaces == null) return toPaces;
  if (canOccupy(unitType, lane, sublane, toPaces, mapId)) return toPaces;
  const features = featuresOnMap(mapId);
  const mob = mobilityClass(unitType);
  const dir = toPaces >= fromPaces ? 1 : -1;
  let best = fromPaces;
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (f.lane !== lane || f.sublanes.indexOf(sublane) < 0) continue;
    const blocked =
      (f.kind === "peak" && mob !== "infantry") ||
      (f.kind === "river" && mob === "artillery" && !riverIsPontoon(f));
    if (!blocked) continue;
    const { minPaces, maxPaces } = featureInterval(f);
    // Edge just outside the footprint in the approach direction.
    if (dir > 0 && fromPaces <= minPaces && toPaces >= minPaces) {
      const edge = minPaces - 1e-6;
      if (edge > best || best === fromPaces) best = Math.max(fromPaces, edge);
    } else if (dir < 0 && fromPaces >= maxPaces && toPaces <= maxPaces) {
      const edge = maxPaces + 1e-6;
      if (edge < best || best === fromPaces) best = Math.min(fromPaces, edge);
    }
  }
  // If already inside somehow, hold position.
  if (!canOccupy(unitType, lane, sublane, best, mapId)) {
    for (let i = 0; i < features.length; i += 1) {
      const f = features[i];
      if (f.lane !== lane || f.sublanes.indexOf(sublane) < 0) continue;
      const blocked =
        (f.kind === "peak" && mob !== "infantry") ||
        (f.kind === "river" && mob === "artillery" && !riverIsPontoon(f));
      if (!blocked) continue;
      const { minPaces, maxPaces } = featureInterval(f);
      if (fromPaces < minPaces || fromPaces > maxPaces) continue;
      const exit = dir > 0 ? maxPaces + 1e-6 : minPaces - 1e-6;
      if (canOccupy(unitType, lane, sublane, exit, mapId)) return exit;
    }
    return fromPaces;
  }
  return best;
}

/**
 * Convert player-keep paces ↔ side progress for a unit side.
 */
export function progressFromPlayerPaces(sideId, lane, playerPaces) {
  const total = Path.lanePaces(lane);
  const t = Math.max(0, Math.min(1, playerPaces / total));
  return sideId === "player" ? t : 1 - t;
}

export function playerPacesFromProgress(sideId, lane, progress) {
  const total = Path.lanePaces(lane);
  const t = sideId === "player" ? progress : 1 - progress;
  return t * total;
}

/** True when artillery is standing on a river that is not currently a pontoon. */
export function unitOnClosedRiver(unit, mapId) {
  if (!unit || mobilityClass(unitTypeKey(unit)) !== "artillery") return false;
  const under = featuresUnder(unit, mapId);
  for (let i = 0; i < under.length; i += 1) {
    if (under[i].kind === "river" && !riverIsPontoon(under[i])) return true;
  }
  return false;
}

/**
 * Public snapshot fields for clients.
 * Pass `{ skipFxRefresh: true }` when the caller already installed match FX
 * via setTerrainFx / refreshTerrainFx (avoids clobbering another room's overlay).
 */
export function snapshotTerrain(viewerSideId, troopsBySide, mapId, opts = {}) {
  const id = mapId || CONFIG.defaultMapId;
  if (!opts.skipFxRefresh) refreshTerrainFx(troopsBySide, id);
  const features = opts.features || serializeMapFeatures(id, _terrainFx.pontoonIds);
  if (opts.skipLos) {
    return {
      mapId: id,
      features,
      foggedFeatureIds: [],
      fogRegions: openFogRegions(id),
    };
  }
  const friendsByLane = opts.friendsByLane || livingByLane(troopsBySide && troopsBySide[viewerSideId]);
  return {
    mapId: id,
    features,
    foggedFeatureIds: foggedFeatureIds(viewerSideId, troopsBySide, id),
    fogRegions: fogLaneRegions(viewerSideId, troopsBySide, id, friendsByLane),
  };
}
