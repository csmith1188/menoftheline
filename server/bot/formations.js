import { CONFIG } from "../../shared/config.js";
import { Path } from "../../shared/path.js";
import { canOccupy, playerPacesOf } from "../../shared/terrain.js";

/**
 * Troop geometry only. A Reform issued while the partner is still outside
 * the sim's recruit window finishes alone and becomes Halt, and the trailer
 * then walks past. Hold the leader until the trailer is close enough to be
 * recruited, then Reform once so the sim stops the trailer on the leader.
 *
 * Reform no longer sidesteps blockers, so never open Reform while a walker
 * is stacked behind a same-row friendly — clear the row first.
 */
export function formationFix(troop, troops) {
  if (!troop || troop.type !== "troop") return null;
  if (troop.order === "charge" || troop.order === "fallback" || troop.order === "retreat") {
    return null;
  }
  if (troop.order === "reform") return "wait";

  const units = [];
  const occupants = [];
  for (let i = 0; i < troops.length; i += 1) {
    const other = troops[i];
    if (other.hp <= 0 || other.lane !== troop.lane) continue;
    occupants.push(other);
    if (other.type === "troop" && !other.broken) units.push(other);
  }
  if (units.length < 2) return null;

  const mate = troop.sameRowMate(units);
  if (mate) {
    const peel = unstackChoice(troop, mate, units);
    if (peel === "stay") return null;
    const free = pickFreeRowNear(troop, occupants);
    if (free != null) return { action: "switch", sublane: free };
  }

  // Non-troop blocker on this row: step off before Reform. Troop stacks
  // already used unstackChoice above; do not peel a line body here.
  if (!mate && rowBlockedTowardFront(troop, occupants)) {
    const free = pickFreeRowNear(troop, occupants);
    if (free != null) return { action: "switch", sublane: free };
  }

  const nearest = nearestSameType(troop, units);
  if (nearest && Math.abs(nearest.sublane - troop.sublane) > 1) {
    const step = nearest.sublane > troop.sublane ? troop.sublane + 1 : troop.sublane - 1;
    if (rowFreeFor(troop, occupants, step)) return { action: "switch", sublane: step };
  }

  const line = troop.lineGroup(units);
  if (line.length >= 2) {
    for (let i = 0; i < line.length; i += 1) {
      if (line[i].order === "reform") return "wait";
    }
    const front = lineFront(line);
    if (!troop.lineIsSquare(line)) {
      if (troop !== front) return "wait";
      return reformIfClear(front, line, occupants);
    }
    const stray = strayBehind(line, units);
    if (!stray) return null;
    if (troop !== front) return "wait";
    if (lineCanRecruit(line, stray)) {
      const group = line.slice();
      if (!lineHas(group, stray)) group.push(stray);
      return reformIfClear(front, group, occupants);
    }
    return {
      action: "halt",
      group: true,
      catchIn: timeToJoin(stray, front),
    };
  }

  const behind = troop.nextBehindOtherSublane(units);
  const ahead = troop.nextAheadOtherSublane(units);
  if (behind && troop.withinLine(behind)) {
    return reformIfClear(lineFront([troop, behind]), [troop, behind], occupants);
  }
  if (ahead && troop.withinLine(ahead)) {
    return reformIfClear(lineFront([troop, ahead]), [troop, ahead], occupants);
  }
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

/**
 * Peel the unit that is not already holding a multi-body line. When both
 * (or neither) are in a line, the lower id stays so only one body moves.
 */
function unstackChoice(troop, mate, units) {
  const meInLine = troop.lineGroup(units).length >= 2;
  const mateInLine = mate.lineGroup(units).length >= 2;
  if (meInLine && !mateInLine) return "stay";
  if (!meInLine && mateInLine) return "peel";
  if (troop.id > mate.id) return "stay";
  return "peel";
}

/** Reform when every trailer can walk up on its own row; otherwise wait. */
function reformIfClear(front, group, occupants) {
  if (!walkUpClear(front, group, occupants)) return "wait";
  return { action: "reform" };
}

/**
 * True when each non-front member has a clear same-row path up to the
 * front's progress. A stacked mate or other collidable in that stretch
 * would freeze Reform in place.
 */
function walkUpClear(front, group, occupants) {
  for (let i = 0; i < group.length; i += 1) {
    const unit = group[i];
    if (unit === front) continue;
    for (let j = 0; j < occupants.length; j += 1) {
      const ally = occupants[j];
      if (ally === unit || ally.hp <= 0) continue;
      if (ally.sublane !== unit.sublane || ally.lane !== unit.lane) continue;
      if (lineHas(group, ally)) continue;
      if (ally.type === "troop" && !ally.broken) return false;
      if (typeof unit.blocksAlly === "function" && !unit.blocksAlly(ally)) continue;
      if (ally.progress <= unit.progress) continue;
      if (ally.progress <= front.progress + 1e-9) return false;
    }
  }
  return true;
}

/** Collidable friendly close ahead on this row (blocks Reform walk-up). */
function rowBlockedTowardFront(troop, occupants) {
  for (let i = 0; i < occupants.length; i += 1) {
    const ally = occupants[i];
    if (ally === troop) continue;
    if (typeof troop.isBlockedBy === "function" && troop.isBlockedBy(ally)) {
      return true;
    }
  }
  return false;
}

/** Paces per second along the lane, matching Unit.alongDelta (incl. terrain). */
function paceSpeed(troop) {
  const span = Path.topSpanPx();
  if (!(span > 0)) return 0;
  const mult = troop.side && troop.side.speedMultiplier ? troop.side.speedMultiplier : 1;
  const terrain = typeof troop.terrainMoveFactor === "function"
    ? troop.terrainMoveFactor()
    : 1;
  return troop.speed * mult * (CONFIG.topLanePaces / span) * terrain;
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

function rowFreeFor(troop, occupants, sublane) {
  const count = Path.sublaneCount(troop.lane);
  if (sublane < 0 || sublane >= count) return false;
  for (let i = 0; i < occupants.length; i += 1) {
    if (occupants[i] !== troop && occupants[i].sublane === sublane) return false;
  }
  const mapId = typeof troop.mapId === "function" ? troop.mapId() : CONFIG.defaultMapId;
  const paces = playerPacesOf(troop);
  if (paces != null
    && !canOccupy(troop.variant || troop.type, troop.lane, sublane, paces, mapId)) {
    return false;
  }
  return true;
}

function pickFreeRowNear(troop, occupants) {
  const count = Path.sublaneCount(troop.lane);
  const prefs = [troop.sublane - 1, troop.sublane + 1];
  for (let i = 0; i < prefs.length; i += 1) {
    if (rowFreeFor(troop, occupants, prefs[i])) return prefs[i];
  }
  for (let s = 0; s < count; s += 1) {
    if (s !== troop.sublane && rowFreeFor(troop, occupants, s)) return s;
  }
  return null;
}
