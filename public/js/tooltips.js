import { CONFIG } from "../shared/config.js";
import { UNIT_VARIANTS } from "../shared/units.js";
import { Path } from "../shared/path.js";

/** Hold this long on one unit to select only that unit (not its line). */
const SELECT_HOLD_MS = 400;

/** Read the per-page default from the play template. */
export function readTooltipsDefault() {
  const raw = document.body && document.body.dataset
    ? document.body.dataset.tooltipsDefault
    : null;
  return raw !== "0";
}

function nearTop(y) {
  return y < CONFIG.canvasHeight * 0.18;
}

function normalize(dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function pushLabel(labels, text, x, y, id) {
  if (!text) return;
  labels.push({ text, x, y, id });
}

/**
 * Click/hold corner: visual left of the object. Flip for southpaw so the
 * label stays on the screen-left side after the canvas mirror.
 */
function cornerOffset(board, dist, hasSwipes, ax, ay) {
  const left = board.southpaw ? 1 : -1;
  const top = nearTop(ay) ? 1 : -1;
  if (hasSwipes) {
    return { x: left * dist * 1.05, y: top * dist * 1.05 };
  }
  return { x: 0, y: top * dist };
}

/** Build press-time gesture hints for a friendly unit. */
export function buildUnitHints(board, troop) {
  if (!troop) return null;
  const ax = troop.x;
  const ay = troop.y;
  // Keep on-screen padding past the body the same when zoomed: only the
  // decorative offset shrinks with telescope scale, not the body radius.
  const zoom = board.telescope
    ? board.telescopeScale(board.telescope.lane)
    : 1;
  const pad = (36 * CONFIG.uiScale) / zoom;
  const radius = (troop.bodyRadius ? troop.bodyRadius() : 14) + pad;
  const tan = Path.tangentAt(
    Path.waypoints(troop.side.id, troop.lane, troop.sublane),
    troop.progress || 0,
  );
  const fwd = normalize(tan.x, tan.y);
  const across = normalize(-tan.y, tan.x);
  const labels = [];
  pushLabel(labels, "Charge", ax + fwd.x * radius, ay + fwd.y * radius, "charge");
  pushLabel(labels, "Fall back", ax - fwd.x * radius, ay - fwd.y * radius, "fallback");
  const solo = switchHintSolo(board, troop);
  const downDir = board.acrossSwipeDir(troop, true);
  const upDir = board.acrossSwipeDir(troop, false);
  if (downDir) {
    const word = board.switchSwipeLabel(troop, downDir, solo);
    pushLabel(labels, `${word} Down`, ax + across.x * radius, ay + across.y * radius, "switch-down");
  }
  if (upDir) {
    const word = board.switchSwipeLabel(troop, upDir, solo);
    pushLabel(labels, `${word} Up`, ax - across.x * radius, ay - across.y * radius, "switch-up");
  }

  const click = troop.order === "halt" ? "Advance" : "Halt";
  const corner = cornerOffset(board, radius, true, ax, ay);
  const stack = (12 * CONFIG.uiScale) / zoom;
  const nudge = 40 / zoom;
  pushLabel(labels, click, ax + corner.x - nudge, ay + corner.y - stack, "click");
  pushLabel(labels, "Solo", ax + corner.x - nudge, ay + corner.y + stack, "solo");
  return { labels, active: "click", kind: "unit" };
}

function switchHintSolo(board, troop) {
  if (board.drag && board.drag.soloPick) return true;
  if (board.isTroopInMelee && board.isTroopInMelee(troop)) return true;
  return false;
}

/** Keep Switch/Reform wording current while the press is held. */
function refreshUnitSwitchLabels(board) {
  const hints = board.gestureHints;
  const drag = board.drag;
  if (!hints || !hints.labels || !drag || !drag.troop) return;
  const troop = drag.troop;
  const solo = switchHintSolo(board, troop);
  const downDir = board.acrossSwipeDir(troop, true);
  const upDir = board.acrossSwipeDir(troop, false);
  for (let i = 0; i < hints.labels.length; i += 1) {
    const label = hints.labels[i];
    if (label.id === "switch-down" && downDir) {
      label.text = `${board.switchSwipeLabel(troop, downDir, solo)} Down`;
    } else if (label.id === "switch-up" && upDir) {
      label.text = `${board.switchSwipeLabel(troop, upDir, solo)} Up`;
    }
  }
}

/** Build press-time gesture hints for a buy button. */
export function buildBuyHints(board, type, rect) {
  if (!rect) return null;
  const ax = rect.x + rect.w / 2;
  const ay = rect.y + rect.h / 2;
  const ox = rect.w * 1.05;
  const oy = rect.h * 1.15;
  const labels = [];
  if (board.trainingMode) {
    pushLabel(labels, "Deploy Bottom", ax, ay + oy, "bottom");
  } else {
    pushLabel(labels, "Deploy Top", ax, ay - oy, "top");
    pushLabel(labels, "Deploy Bottom", ax, ay + oy, "bottom");
  }
  if (UNIT_VARIANTS[type]) {
    pushLabel(labels, "Change Type", ax - ox, ay, "type-left");
    pushLabel(labels, "Change Type", ax + ox, ay, "type-right");
  }
  const hasSwipes = true;
  const corner = cornerOffset(board, Math.max(rect.w, rect.h) * 0.75, hasSwipes, ax, ay);
  pushLabel(labels, "Hold for Stats", ax + corner.x - 40, ay + corner.y, "stats");
  return { labels, active: null, kind: "buy" };
}

/** Build press-time gesture hints for a strategy button. */
export function buildStrategyHints(board, rect) {
  if (!rect) return null;
  const ax = rect.x + rect.w / 2;
  const ay = rect.y + rect.h / 2;
  const ox = rect.w * 1.15;
  const labels = [];
  pushLabel(labels, "Prev", ax - ox, ay, "prev");
  pushLabel(labels, "Next", ax + ox, ay, "next");
  return { labels, active: null, kind: "strategy" };
}

/** Which hint fires if the player releases with the current pointer pose. */
export function refreshGestureHintActive(board) {
  const hints = board.gestureHints;
  if (!hints || !hints.labels) return;
  let active = null;
  if (hints.kind === "unit" && board.drag && board.drag.troop) {
    refreshUnitSwitchLabels(board);
    active = unitActiveId(board);
  } else if (hints.kind === "buy" && board.buyDrag) {
    active = buyActiveId(board);
  } else if (hints.kind === "strategy" && board.strategyDrag) {
    active = strategyActiveId(board);
  }
  hints.active = active;
}

function unitActiveId(board) {
  const drag = board.drag;
  const troop = drag.troop;
  const point = { x: drag.hx, y: drag.hy };
  const pulled = board.dragPullFromUnit(drag, point, troop);
  const orderMin = board.orderDragMin();
  if (pulled < orderMin) {
    if (drag.soloPick || (drag.downAt != null
        && performance.now() - drag.downAt >= SELECT_HOLD_MS
        && board.hitAnyTroopAt(point) === troop)) {
      return "solo";
    }
    return "click";
  }
  const intent = board.dragIntent(troop, drag, point);
  if (intent.kind === "charge") return "charge";
  if (intent.kind === "fallback") return "fallback";
  if ((intent.kind === "lane" || intent.kind === "nudge")
      && pulled >= board.laneDragMin()) {
    const dx = point.x - drag.x;
    const dy = point.y - drag.y;
    const tan = Path.tangentAt(
      Path.waypoints(troop.side.id, troop.lane, troop.sublane),
      troop.progress || 0,
    );
    const across = dx * -tan.y + dy * tan.x;
    return across > 0 ? "switch-down" : "switch-up";
  }
  return null;
}

function buyActiveId(board) {
  const start = board.buyDrag;
  if (start.infoOpened) return "stats";
  const point = { x: start.hx, y: start.hy };
  const swipe = board.buyVariantFromSwipe(start, point);
  if (swipe === -1) return "type-left";
  if (swipe === 1) return "type-right";
  const lane = board.buyLaneFromSwipe(start, point);
  if (lane === "top") return "top";
  if (lane === "bottom") return "bottom";
  return "stats";
}

function strategyActiveId(board) {
  const start = board.strategyDrag;
  const point = { x: start.hx, y: start.hy };
  const swipe = board.strategySwipeDir(start, point);
  if (swipe === -1) return "prev";
  if (swipe === 1) return "next";
  return null;
}

export function clearGestureHints(board) {
  board.gestureHints = null;
}

export function showUnitHints(board, troop) {
  if (!board.tooltips) {
    board.gestureHints = null;
    return;
  }
  board.gestureHints = buildUnitHints(board, troop);
  refreshGestureHintActive(board);
}

export function showBuyHints(board, type, rect) {
  if (!board.tooltips) {
    board.gestureHints = null;
    return;
  }
  board.gestureHints = buildBuyHints(board, type, rect);
  refreshGestureHintActive(board);
}

export function showStrategyHints(board, rect) {
  if (!board.tooltips) {
    board.gestureHints = null;
    return;
  }
  board.gestureHints = buildStrategyHints(board, rect);
  refreshGestureHintActive(board);
}
