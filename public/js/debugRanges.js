import { CONFIG } from "../shared/config.js";
import { unitStats } from "../shared/units.js";
import { Path } from "../shared/path.js";

/** True when the server was started with the debug script. */
export function debugRangesOn() {
  return typeof window !== "undefined" && window.DEBUG_RANGES === true;
}

function laneTOf(troop) {
  return troop.side && troop.side.id === "player" ? troop.progress : 1 - troop.progress;
}

function clampSpan(lane, centerT, paces) {
  const half = paces / Path.lanePaces(lane);
  return [Math.max(0, centerT - half), Math.min(1, centerT + half)];
}

/** Range in front of the unit only, toward the enemy keep. */
function aheadSpan(lane, centerT, paces, sideId) {
  const delta = paces / Path.lanePaces(lane);
  if (sideId === "player") return [centerT, Math.min(1, centerT + delta)];
  return [Math.max(0, centerT - delta), centerT];
}

function rowWidth(lane) {
  return lane === "bottom" ? CONFIG.bottomSublaneWidth : CONFIG.topSublaneWidth;
}

/** Points along one row from progress t0 to t1, measured from the player keep. */
export function spanPolyline(lane, sublane, t0, t1) {
  const pts = Path.worldPoints(lane, sublane);
  const steps = lane === "bottom" ? 18 : 1;
  const out = [];
  const from = Math.max(0, Math.min(1, t0));
  const to = Math.max(0, Math.min(1, t1));
  for (let i = 0; i <= steps; i += 1) {
    const t = from + (to - from) * (i / steps);
    out.push(Path.pointAt(pts, t));
  }
  return out;
}

function pushSpan(marks, lane, sublane, t0, t1, color, alpha, width, box) {
  if (!(t1 > t0)) return;
  marks.push({
    points: spanPolyline(lane, sublane, t0, t1),
    color,
    alpha,
    width,
    box: Boolean(box),
  });
}

function pushBox(marks, lane, sublane, t0, t1, color, alpha) {
  pushSpan(marks, lane, sublane, t0, t1, color, alpha, rowWidth(lane), true);
}

function firingPaces(troop) {
  const stats = unitStats(troop.variant || troop.type);
  const full = Path.pacesFromPx(stats.range || 0);
  const fraction = troop.order === "halt" ? 1 : (stats.engageRange == null ? 0.5 : stats.engageRange);
  const active = full * fraction;
  return { full, active };
}

/** Overlay strokes for weapon ranges, footprints, restores, forts, and keep bands. */
export function collectDebugMarks(board) {
  const marks = [];
  if (!board || !board.player) return marks;
  const troops = board.player.troops.concat(board.enemy.troops);
  for (let i = 0; i < troops.length; i += 1) {
    const troop = troops[i];
    if (!troop || troop.hp <= 0 || !troop.lane) continue;
    const t = laneTOf(troop);
    const sideId = troop.side && troop.side.id;
    const { full, active } = firingPaces(troop);
    const [full0, full1] = aheadSpan(troop.lane, t, full, sideId);
    pushSpan(marks, troop.lane, troop.sublane, full0, full1, "#ffe27a", 0.35, 2);
    if (Math.abs(active - full) > 0.5) {
      const [a0, a1] = aheadSpan(troop.lane, t, active, sideId);
      pushSpan(marks, troop.lane, troop.sublane, a0, a1, "#ff9a3c", 0.85, 3);
    }
    const [foot0, foot1] = clampSpan(troop.lane, t, CONFIG.footprintPaces);
    const meleePaces = CONFIG.footprintPaces + (CONFIG.meleeSlack || 0) / 2;
    const [melee0, melee1] = clampSpan(troop.lane, t, meleePaces);
    const [line0, line1] = clampSpan(troop.lane, t, CONFIG.inLinePaces);
    const [perfect0, perfect1] = clampSpan(troop.lane, t, CONFIG.perfectLinePaces);
    pushBox(marks, troop.lane, troop.sublane, melee0, melee1, "#ff5a3c", 0.45);
    pushBox(marks, troop.lane, troop.sublane, foot0, foot1, "#ffffff", 0.28);
    pushBox(marks, troop.lane, troop.sublane, line0, line1, "#7ec8ff", 0.4);
    pushBox(marks, troop.lane, troop.sublane, perfect0, perfect1, "#ff6ad5", 0.7);
    if (troop.type === "officer") {
      const color = troop.variant === "colorGuard" ? "#7dffb2" : "#7ec8ff";
      const rows = Path.sublaneCount(troop.lane);
      const [r0, r1] = clampSpan(troop.lane, t, CONFIG.officerRestorePaces);
      for (let row = 0; row < rows; row += 1) {
        pushSpan(marks, troop.lane, row, r0, r1, color, 0.28, 2);
      }
    }
  }
  const lanes = ["top", "bottom"];
  for (let n = 0; n < lanes.length; n += 1) {
    const lane = lanes[n];
    const rows = Path.sublaneCount(lane);
    const bands = CONFIG.keepAuraPaces;
    const sides = ["player", "enemy"];
    for (let s = 0; s < sides.length; s += 1) {
      for (let b = 0; b < bands.length; b += 1) {
        const frac = bands[b] / Path.lanePaces(lane);
        const at = sides[s] === "player" ? frac : 1 - frac;
        const near = Path.pointAt(Path.worldPoints(lane, 0), at);
        const far = Path.pointAt(Path.worldPoints(lane, rows - 1), at);
        marks.push({
          points: [near, far],
          color: "#9ee07a",
          alpha: 0.35 + (bands.length - b) * 0.15,
          width: 2,
        });
      }
    }
    for (let s = 0; s < sides.length; s += 1) {
      const center = Path.fortStation(lane, sides[s]) / (Path.lanePaces(lane) * Path.stationPerPace(lane));
      const [t0, t1] = clampSpan(lane, center, CONFIG.footprintPaces);
      for (let row = 0; row < rows; row += 1) {
        pushSpan(marks, lane, row, t0, t1, sides[s] === "player" ? "#4aa3ff" : "#e85d4c", 0.35, 3);
      }
    }
  }
  return marks;
}

/** Paint the overlay on the 2D board, under the units. */
export function drawDebugRanges(ctx, board) {
  if (!debugRangesOn()) return;
  const marks = collectDebugMarks(board);
  ctx.save();
    ctx.lineJoin = "round";
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i];
      const pts = mark.points;
      if (!pts || pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let p = 1; p < pts.length; p += 1) ctx.lineTo(pts[p].x, pts[p].y);
      ctx.strokeStyle = mark.color;
      ctx.globalAlpha = mark.alpha;
      ctx.lineWidth = mark.width;
      ctx.lineCap = mark.box ? "butt" : "round";
      ctx.stroke();
    }
    // Pointer hit rings (body + unitReach) so touch targets can be tuned.
    const reach = board.uiMetrics ? board.uiMetrics().unitReach : 0;
    const sides = [board.player, board.enemy];
    for (let s = 0; s < sides.length; s += 1) {
      const side = sides[s];
      if (!side) continue;
      for (let i = 0; i < side.troops.length; i += 1) {
        const troop = side.troops[i];
        if (troop.hp <= 0) continue;
        const r = (troop.bodyRadius ? troop.bodyRadius() : 10) + reach;
        ctx.beginPath();
        ctx.arc(troop.x, troop.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = side.id === "player" ? "#7ec8ff" : "#ff9a8a";
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  ctx.restore();
}
