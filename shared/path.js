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

  /**
   * How close two stations must be. Top uses pixels. Bottom uses the
   * sweep angle from the keep-to-center radius; line and parallel match
   * the top-lane pixel windows so units are not counted in line when
   * they are still far around the arc.
   */
  stationSlack(lane, kind, radius) {
    if (lane !== "bottom") {
      if (kind === "parallel") {
        return CONFIG.parallelEpsilon;
      }
      if (kind === "line") {
        return CONFIG.lineWindow;
      }
      if (kind === "flank") {
        return CONFIG.flankWindow;
      }
      return CONFIG.blockGap;
    }
    const px = kind === "parallel"
      ? CONFIG.parallelEpsilon
      : kind === "line"
        ? CONFIG.lineWindow
        : kind === "flank"
          ? CONFIG.flankWindow
          : CONFIG.blockGap;
    const r = kind === "block"
      ? (radius || Path.bottomMidRadius())
      : Path.bottomMidRadius();
    return Path.arcDegrees(px, r);
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
   * Cover bars at 1/4 of the lane from each keep: vertical on top,
   * radial on the bottom rings. Thickness matches a troop.
   */
export function quarterSegments() {
    const left = CONFIG.playerCapital;
    const right = CONFIG.enemyCapital;
    const topY = left.y - CONFIG.topLaneHeight / 2;
    const botY = left.y + CONFIG.topLaneHeight / 2;
    const span = right.x - left.x;
    const px = left.x + CONFIG.quarterMark * span;
    const ex = left.x + (1 - CONFIG.quarterMark) * span;
    const c = Path.bottomCenter();
    const rIn = Path.bottomRadius(CONFIG.bottomSublaneCount - 1);
    const rOut = Path.bottomRadius(0);
    const pTheta = Math.PI * (1 - CONFIG.quarterMark);
    const eTheta = Math.PI * CONFIG.quarterMark;
    return [
      { x1: px, y1: topY, x2: px, y2: botY, color: CONFIG.colors.player },
      { x1: ex, y1: topY, x2: ex, y2: botY, color: CONFIG.colors.enemy },
      {
        x1: c.x + rIn * Math.cos(pTheta),
        y1: c.y + rIn * Math.sin(pTheta),
        x2: c.x + rOut * Math.cos(pTheta),
        y2: c.y + rOut * Math.sin(pTheta),
        color: CONFIG.colors.player,
      },
      {
        x1: c.x + rIn * Math.cos(eTheta),
        y1: c.y + rIn * Math.sin(eTheta),
        x2: c.x + rOut * Math.cos(eTheta),
        y2: c.y + rOut * Math.sin(eTheta),
        color: CONFIG.colors.enemy,
      },
    ];
  }


export function quarterThickness() {
    return CONFIG.troopRadius * 2;
  }


export function touchesQuarterLine(troop) {
    const reach = troop.bodyRadius() + quarterThickness() / 2;
    const segs = quarterSegments();
    for (let i = 0; i < segs.length; i += 1) {
      const s = segs[i];
      if (pointToSegment(troop, s.x1, s.y1, s.x2, s.y2) <= reach) {
        return true;
      }
    }
    return false;
  }
