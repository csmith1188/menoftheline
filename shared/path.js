import { CONFIG } from "./config.js";

/**
 * Euclidean distance between two points with x/y.
 * Used by autoattack targeting, blocking, projectiles, and capture.
 */
export function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/** Shortest distance from a point to a segment. */
export function pointToSegment(p, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2));
  }
  return Math.hypot(p.x - (ax + dx * t), p.y - (ay + dy * t));
}

/**
 * Polyline helpers shared by movement, capture tests, and lane drawing.
 * progress 0 is the buying side's capital; progress 1 is the enemy capital.
 * Sublane 0 is the northernmost top row / outermost bottom half-circle.
 */
export const Path = {
  /** How many parallel rows a lane has. */
  sublaneCount(lane) {
    return lane === "top" ? CONFIG.topSublaneCount : CONFIG.bottomSublaneCount;
  },

  /** Map a sublane index onto -1..1 so both lanes share the same spread math. */
  sublaneNorm(sublane, count) {
    if (count <= 1) {
      return 0;
    }
    return (sublane / (count - 1)) * 2 - 1;
  },

  /**
   * World-space waypoints traveling player-left to enemy-right.
   * Enemy troops walk the same points reversed so sublanes stay aligned.
   */
  worldPoints(lane, sublane) {
    const left = CONFIG.playerCapital;
    const right = CONFIG.enemyCapital;

    if (lane === "top") {
      const n = Path.sublaneNorm(sublane, CONFIG.topSublaneCount);
      const y = left.y + n * CONFIG.topSublaneSpread;
      return [
        { x: left.x, y },
        { x: right.x, y },
      ];
    }

    const c = Path.bottomCenter();
    const radius = Path.bottomRadius(sublane);
    const points = [];
    const segs = CONFIG.bottomArcSegments;
    for (let i = 0; i <= segs; i += 1) {
      const theta = Math.PI * (1 - i / segs);
      points.push({
        x: c.x + radius * Math.cos(theta),
        y: c.y + radius * Math.sin(theta),
      });
    }
    return points;
  },

  /** Shared center of the three bottom half-circles (midpoint of the keeps). */
  bottomCenter() {
    return {
      x: (CONFIG.playerCapital.x + CONFIG.enemyCapital.x) / 2,
      y: CONFIG.playerCapital.y,
    };
  },

  /** Distance from the shared center to each keep — the middle ring's radius. */
  bottomMidRadius() {
    const left = CONFIG.playerCapital;
    const right = CONFIG.enemyCapital;
    return Math.hypot(right.x - left.x, right.y - left.y) / 2;
  },

  /** Sublane 0 is the outer ring, 2 is the inner ring. */
  bottomRadius(sublane) {
    const n = Path.sublaneNorm(sublane, CONFIG.bottomSublaneCount);
    return Path.bottomMidRadius() - n * CONFIG.bottomSublaneSpread;
  },

  /**
   * Sweep angle from the starting radius (center → player keep) to this
   * point: 0° at the player keep, 90° due south, 180° at the enemy keep.
   */
  bottomStationDeg(x, y) {
    const c = Path.bottomCenter();
    const deg = Math.atan2(y - c.y, x - c.x) * (180 / Math.PI);
    if (deg < 0) {
      return deg > -90 ? 180 : 0;
    }
    return 180 - deg;
  },

  /** Convert a pixel gap into degrees on a ring of this radius. */
  arcDegrees(pixels, radius) {
    if (radius <= 0) {
      return 0;
    }
    return (pixels / radius) * (180 / Math.PI);
  },

  /** Gameplay length of a lane, in paces. Both rows of a lane share it. */
  lanePaces(lane) {
    return lane === "bottom" ? CONFIG.bottomLanePaces : CONFIG.topLanePaces;
  },

  /** Pixel length of the top lane, the ruler that turns walk speed into paces. */
  topSpanPx() {
    return CONFIG.enemyCapital.x - CONFIG.playerCapital.x;
  },

  /** How many station units (pixels or degrees) one pace covers on this lane. */
  stationPerPace(lane) {
    if (lane === "bottom") {
      return 180 / CONFIG.bottomLanePaces;
    }
    const span = Path.topSpanPx();
    return span > 0 ? span / CONFIG.topLanePaces : 0;
  },

  /** Convert a pixel distance into paces using the top-lane ruler. */
  pacesFromPx(pixels) {
    const span = Path.topSpanPx();
    return span > 0 ? pixels * (CONFIG.topLanePaces / span) : 0;
  },

  /**
   * Along-lane window in this lane's station units.
   * Config paces are each side from a unit's center. Two units match when
   * those reaches overlap, so parallel / line / block all use twice the
   * config value (reach + reach). gun is both footprints plus the
   * penetrate gap (see CONFIG.gunPenetratePaces). melee is both
   * footprints plus CONFIG.meleeSlack (paces) so units can lock melee
   * while standing just outside each other's footprints.
   */
  stationSlack(lane, kind) {
    let paces = CONFIG.footprintPaces * 2;
    if (kind === "parallel") paces = CONFIG.perfectLinePaces * 2;
    else if (kind === "line") paces = CONFIG.inLinePaces * 2;
    else if (kind === "gun") {
      paces = CONFIG.footprintPaces * 2 + (CONFIG.gunPenetratePaces || 0);
    } else if (kind === "melee") {
      paces = CONFIG.footprintPaces * 2 + (CONFIG.meleeSlack || 0);
    }
    return paces * Path.stationPerPace(lane);
  },

  /** Station of a fort center measured from the player keep. */
  fortStation(lane, sideId) {
    const along = CONFIG.fortDistancePaces * Path.stationPerPace(lane);
    if (sideId === "player") return along;
    return Path.lanePaces(lane) * Path.stationPerPace(lane) - along;
  },

  /**
   * Which sublane of this lane sits closest to a world point, compared
   * at the given progress so a drag picks a row beside the unit.
   */
  closestSublane(sideId, lane, progress, point) {
    const count = Path.sublaneCount(lane);
    let best = 0;
    let bestD = Infinity;
    for (let s = 0; s < count; s += 1) {
      const pos = Path.pointAt(Path.waypoints(sideId, lane, s), progress);
      const d = distance(point, pos);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  },

  /** Side-facing copy of a sublane: player walks forward, enemy walks it back. */
  waypoints(sideId, lane, sublane) {
    const points = Path.worldPoints(lane, sublane);
    if (sideId === "player") {
      return points;
    }
    return points.slice().reverse();
  },

  /** Sum of segment lengths so speed can be converted into path progress. */
  length(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      total += distance(points[i - 1], points[i]);
    }
    return total;
  },

  /** The polyline segment that contains progress t, plus how far along it. */
  segmentAt(points, t) {
    const total = Path.length(points);
    if (total <= 0 || points.length < 2) {
      const p = points[0];
      return { from: p, to: p, u: 0 };
    }
    let remaining = Math.max(0, Math.min(1, t)) * total;
    for (let i = 1; i < points.length; i += 1) {
      const from = points[i - 1];
      const to = points[i];
      const seg = distance(from, to);
      if (remaining <= seg || i === points.length - 1) {
        return { from, to, u: seg === 0 ? 0 : remaining / seg };
      }
      remaining -= seg;
    }
    const last = points[points.length - 1];
    return { from: last, to: last, u: 1 };
  },

  /** Interpolate a world position at progress t in [0, 1]. */
  pointAt(points, t) {
    const { from, to, u } = Path.segmentAt(points, t);
    return {
      x: from.x + (to.x - from.x) * u,
      y: from.y + (to.y - from.y) * u,
    };
  },

  /** Forward unit tangent at progress t. Top is axis-aligned; bottom follows the arc. */
  tangentAt(points, t) {
    const { from, to } = Path.segmentAt(points, t);
    const len = distance(from, to);
    if (len === 0) {
      return { x: 1, y: 0 };
    }
    return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
  },

  /** Middle-sublane polyline, used as the shared station for every row. */
  centerline(lane) {
    return Path.worldPoints(lane, Math.floor(Path.sublaneCount(lane) / 2));
  },

  /**
   * Shared lineup coordinate: pixels along the top centerline, or
   * degrees around the bottom half-circles (0 at player, 180 at enemy).
   */
  stationAt(lane, x, y) {
    if (lane === "bottom") {
      return Path.bottomStationDeg(x, y);
    }
    const points = Path.centerline(lane);
    let bestDist = Infinity;
    let bestAlong = 0;
    let walked = 0;
    for (let i = 1; i < points.length; i += 1) {
      const from = points[i - 1];
      const to = points[i];
      const seg = distance(from, to);
      let u = 0;
      if (seg > 0) {
        u = ((x - from.x) * (to.x - from.x) + (y - from.y) * (to.y - from.y)) / (seg * seg);
        u = Math.max(0, Math.min(1, u));
      }
      const px = from.x + (to.x - from.x) * u;
      const py = from.y + (to.y - from.y) * u;
      const d = Math.hypot(x - px, y - py);
      if (d < bestDist) {
        bestDist = d;
        bestAlong = walked + u * seg;
      }
      walked += seg;
    }
    return bestAlong;
  },
};


  /**
   * Cover bars 250 paces from each keep: vertical on top, radial on the
   * bottom rings. Each bar belongs to the keep it sits in front of.
   */
export function quarterSegments() {
    const left = CONFIG.playerCapital;
    const right = CONFIG.enemyCapital;
    const topY = left.y - CONFIG.topLaneHeight / 2;
    const botY = left.y + CONFIG.topLaneHeight / 2;
    const span = right.x - left.x;
    const topLen = Path.lanePaces("top") * Path.stationPerPace("top");
    const px = left.x + (span > 0 && topLen > 0
      ? (Path.fortStation("top", "player") / topLen) * span
      : left.x);
    const ex = left.x + (span > 0 && topLen > 0
      ? (Path.fortStation("top", "enemy") / topLen) * span
      : right.x);
    const c = Path.bottomCenter();
    const rIn = Path.bottomRadius(CONFIG.bottomSublaneCount - 1);
    const rOut = Path.bottomRadius(0);
    const bottomLen = Path.lanePaces("bottom") * Path.stationPerPace("bottom");
    const pFrac = bottomLen > 0 ? Path.fortStation("bottom", "player") / bottomLen : 0;
    const eFrac = bottomLen > 0 ? Path.fortStation("bottom", "enemy") / bottomLen : 1;
    const pTheta = Math.PI * (1 - pFrac);
    const eTheta = Math.PI * (1 - eFrac);
    return [
      { x1: px, y1: topY, x2: px, y2: botY, color: CONFIG.colors.player, side: "player" },
      { x1: ex, y1: topY, x2: ex, y2: botY, color: CONFIG.colors.enemy, side: "enemy" },
      {
        x1: c.x + rIn * Math.cos(pTheta),
        y1: c.y + rIn * Math.sin(pTheta),
        x2: c.x + rOut * Math.cos(pTheta),
        y2: c.y + rOut * Math.sin(pTheta),
        color: CONFIG.colors.player,
        side: "player",
      },
      {
        x1: c.x + rIn * Math.cos(eTheta),
        y1: c.y + rIn * Math.sin(eTheta),
        x2: c.x + rOut * Math.cos(eTheta),
        y2: c.y + rOut * Math.sin(eTheta),
        color: CONFIG.colors.enemy,
        side: "enemy",
      },
    ];
  }


export function quarterThickness() {
    return CONFIG.footprintPaces * 2 * Path.stationPerPace("top");
  }


/** Footprint reach used for fort overlap, in paces from the fort center. */
export function fortFootprintPaces() {
  return CONFIG.footprintPaces * 2;
}

/** Shared 0..1 coordinate from the player keep (server Unit or client troop). */
export function troopLaneT(troop) {
  if (!troop) return 0;
  if (typeof troop.laneT === "function") return troop.laneT();
  const sideId = troop.side && troop.side.id;
  return sideId === "player" ? (troop.progress || 0) : 1 - (troop.progress || 0);
}

/** True when this footprint overlaps its own fort in this lane. */
export function touchesQuarterLine(troop) {
    const sideId = troop.side && troop.side.id;
    if (!sideId || !troop.lane) {
      return false;
    }
    if (typeof troop.station === "function") {
      const fort = Path.fortStation(troop.lane, sideId);
      return Math.abs(troop.station() - fort) <= Path.stationSlack(troop.lane, "block");
    }
    // Client troops: compare along-lane paces to the fort.
    const paces = pacesFromKeepOf(troop, sideId);
    if (paces == null) return false;
    return Math.abs(paces - CONFIG.fortDistancePaces) <= fortFootprintPaces();
  }

/**
 * Paces from a keep to a body along that body's lane.
 * Works for server Units, client snapshot troops (progress + side), and
 * keeps / Sides (0 from own keep, lane length from the other).
 */
export function pacesFromKeepOf(body, keepSideId, lane) {
  if (!body) return null;
  if (typeof body.pacesFromKeep === "function") {
    return body.pacesFromKeep(keepSideId);
  }
  // Keep / Side attacker: no lane of its own.
  if (body.capitalHP !== undefined || (body.capital && body.id)) {
    const ownId = body.id;
    if (ownId === keepSideId) return 0;
    const useLane = lane || "top";
    return Path.lanePaces(useLane);
  }
  const useLane = body.lane || lane;
  if (!useLane || !body.side) return null;
  const total = Path.lanePaces(useLane);
  const fromPlayer = troopLaneT(body) * total;
  return keepSideId === "player" ? fromPlayer : total - fromPlayer;
}

/**
 * True when no living foe stands between this side's keep and either fort
 * (paces from keep ≤ fort distance). Same rule as keep health restore.
 */
export function fortsClearOfEnemies(sideId, foes) {
  const limit = CONFIG.fortDistancePaces;
  const list = foes || [];
  for (let i = 0; i < list.length; i += 1) {
    const foe = list[i];
    if (!foe || foe.hp <= 0) continue;
    const paces = pacesFromKeepOf(foe, sideId);
    if (paces != null && paces <= limit) return false;
  }
  return true;
}

/**
 * True when the defender is at or behind its own fort and the attacker
 * is past that fort (outside the fort footprint, toward the enemy).
 * Shooting into or through a fort from in front grants cover; standing
 * in the fort with the attacker, or being shot from behind it, does not.
 */
export function hasFortCover(defender, attacker) {
  const sideId = defender && defender.side && defender.side.id;
  if (!sideId || !defender.lane || !attacker) return false;

  const fort = CONFIG.fortDistancePaces;
  const slack = fortFootprintPaces();
  const defPaces = pacesFromKeepOf(defender, sideId);
  // At or behind: inside the fort footprint, or closer to own keep.
  if (defPaces == null || !(defPaces <= fort + slack)) return false;

  const atkPaces = pacesFromKeepOf(attacker, sideId, defender.lane);
  if (atkPaces == null) return false;
  // Attacker must be strictly past the fort footprint.
  return atkPaces > fort + slack;
}

/** True when this body is at or behind its own fort (cover zone). */
export function inOwnFortCoverZone(troop) {
  const sideId = troop && troop.side && troop.side.id;
  if (!sideId || !troop.lane) return false;
  const paces = pacesFromKeepOf(troop, sideId);
  if (paces == null) return false;
  const fort = CONFIG.fortDistancePaces;
  const slack = fortFootprintPaces();
  return paces <= fort + slack;
}
