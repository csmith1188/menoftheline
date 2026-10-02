import { CONFIG } from "../../shared/config.js";
import { Path } from "../../shared/path.js";

/**
 * Troop geometry only. A Reform issued while the partner is still outside
 * the sim's recruit window finishes alone and becomes Halt, and the trailer
 * then walks past. Hold the leader until the trailer is close enough to be
 * recruited, then Reform once so the sim stops the trailer on the leader.
 */
export function formationFix(troop, troops) {
  if (!troop || troop.type !== "troop") return null;
  if (troop.order === "charge" || troop.order === "fallback" || troop.order === "retreat") {
    return null;
  }
  if (troop.order === "reform") return "wait";

  const units = [];
  for (let i = 0; i < troops.length; i += 1) {
    if (troops[i].type === "troop" && troops[i].hp > 0 && !troops[i].broken) {
      units.push(troops[i]);
    }
  }
  if (units.length < 2) return null;

  const mate = troop.sameRowMate(units);
  if (mate) {
    const mateLine = mate.lineGroup(units);
    if (mateLine.length < 2 && troop.id > mate.id) return null;
    const free = pickFreeRowNear(troop, units);
    if (free != null) return { action: "switch", sublane: free };
  }

  const nearest = nearestSameType(troop, units);
  if (nearest && Math.abs(nearest.sublane - troop.sublane) > 1) {
    const step = nearest.sublane > troop.sublane ? troop.sublane + 1 : troop.sublane - 1;
    if (rowFreeFor(troop, units, step)) return { action: "switch", sublane: step };
  }

  const line = troop.lineGroup(units);
  if (line.length >= 2) {
    for (let i = 0; i < line.length; i += 1) {
      if (line[i].order === "reform") return "wait";
    }
    const front = lineFront(line);
    if (!troop.lineIsSquare(line)) {
      if (troop !== front) return "wait";
      return { action: "reform" };
    }
    const stray = strayBehind(line, units);
    if (!stray) return null;
    if (troop !== front) return "wait";
    if (lineCanRecruit(line, stray)) return { action: "reform" };
    return {
      action: "halt",
      group: true,
      catchIn: timeToJoin(stray, front),
    };
  }

  const behind = troop.nextBehindOtherSublane(units);
  const ahead = troop.nextAheadOtherSublane(units);
  if (behind && troop.withinLine(behind)) return { action: "reform" };
  if (ahead && troop.withinLine(ahead)) return { action: "reform" };
  if (behind && !ahead) {
    return {
      action: "halt",
      group: false,
      catchIn: timeToJoin(behind, troop),
    };
  }
  if (ahead && (ahead.order === "halt" || ahead.order === "reform")) {
    return { catchIn: timeToJoin(troop, ahead) };
  }
  return null;
}

/** Paces per second along the lane, matching Unit.alongDelta. */
function paceSpeed(troop) {
  const span = Path.topSpanPx();
  if (!(span > 0)) return 0;
  const mult = troop.side && troop.side.speedMultiplier ? troop.side.speedMultiplier : 1;
  return troop.speed * mult * (CONFIG.topLanePaces / span);
}

/**
 * Seconds until `trailer` reaches the middle of the reform-recruit
 * window behind `leader`, assuming the leader is holding still.
 */
function timeToJoin(trailer, leader) {
  const speed = paceSpeed(trailer);
  if (!(speed > 0)) return 0.05;
  const gap = leader.shotPaces(trailer);
  const window = CONFIG.inLinePaces * 2;
  const target = window * 0.5;
  if (gap <= target) return 0.05;
  return Math.max(0.05, (gap - target) / speed);
}

function lineFront(line) {
  let front = line[0];
  for (let i = 1; i < line.length; i += 1) {
    if (line[i].progress > front.progress) front = line[i];
  }
  return front;
}

function lineHas(line, unit) {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === unit) return true;
  }
  return false;
}

/** Closest same-type unit behind the line and not already in it. */
function strayBehind(line, units) {
  let best = null;
  let bestGap = Infinity;
  for (let i = 0; i < line.length; i += 1) {
    const behind = line[i].nextBehindOtherSublane(units);
    if (!behind || lineHas(line, behind)) continue;
    const gap = line[i].shotPaces(behind);
    if (gap < bestGap) {
      bestGap = gap;
      best = behind;
    }
  }
  return best;
}

function lineCanRecruit(line, stray) {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i].withinLine(stray) && line[i].adjacentRow(stray)) return true;
  }
  return false;
}

function nearestSameType(troop, units) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < units.length; i += 1) {
    const other = units[i];
    if (other === troop) continue;
    const d = Math.hypot(troop.x - other.x, troop.y - other.y);
    if (d < bestD) {
      bestD = d;
      best = other;
    }
  }
  return best;
}

function rowFreeFor(troop, units, sublane) {
  const count = Path.sublaneCount(troop.lane);
  if (sublane < 0 || sublane >= count) return false;
  for (let i = 0; i < units.length; i += 1) {
    if (units[i] !== troop && units[i].sublane === sublane) return false;
  }
  return true;
}

function pickFreeRowNear(troop, units) {
  const count = Path.sublaneCount(troop.lane);
  const prefs = [troop.sublane - 1, troop.sublane + 1];
  for (let i = 0; i < prefs.length; i += 1) {
    if (rowFreeFor(troop, units, prefs[i])) return prefs[i];
  }
  for (let s = 0; s < count; s += 1) {
    if (s !== troop.sublane && rowFreeFor(troop, units, s)) return s;
  }
  return null;
}
