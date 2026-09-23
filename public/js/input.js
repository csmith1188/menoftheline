import { CONFIG } from "../shared/config.js";
import { Path, distance } from "../shared/path.js";
import { unlockAudio } from "./audio.js";

const pointerMethods = {
  /**
   * Left-press on a friendly starts a possible drag-to-row. A short
   * press still issues halt / reform / advance.
   */
  onPointerDown(event) {
    if ((this.winner || this.status !== "playing") || !event.isPrimary) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    const point = this.canvasPoint(event);
    const buy = this.hitBuyAt(point);
    if (buy) {
      this.buyDrag = {
        index: buy.index,
        type: buy.type,
        x: point.x,
        y: point.y,
        hx: point.x,
        hy: point.y,
        lane: null,
      };
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (this.hitBankAt(point, this.player)) {
      this.onCommand({ type: "bank" });
      return;
    }
    const troop = this.hitTroop(event);
    if (!troop) {
      return;
    }
    this.drag = { troop, x: point.x, y: point.y, hx: point.x, hy: point.y };
    this.canvas.setPointerCapture(event.pointerId);
  },

  /** While dragging, keep the hover point so the target row can light up. */
  onPointerMove(event) {
    if (!event.isPrimary) {
      return;
    }
    event.preventDefault();
    if (!this.player) return;
    const point = this.canvasPoint(event);
    this.hover = point;
    if (this.buyDrag) {
      this.buyDrag.hx = point.x;
      this.buyDrag.hy = point.y;
      this.buyDrag.lane = this.buyLaneFromSwipe(this.buyDrag, point);
    }
    if (this.drag) {
      this.drag.hx = point.x;
      this.drag.hy = point.y;
    }
    const overUI = this.hitBuyAt(point) || this.hitBankAt(point, this.player);
    this.canvas.style.cursor = overUI ? "pointer" : "default";
  },

  /**
   * Left-release: drag across to change row, forward to charge, back
   * to fall back, click to cycle halt / reform / advance, or click a
   * town you own to buy its upgrade. Only fallback works in melee.
   */
  onPointerUp(event) {
    if (!event.isPrimary) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (this.buyDrag) {
      const start = this.buyDrag;
      this.buyDrag = null;
      if (this.winner || this.status !== "playing") {
        return;
      }
      const point = this.canvasPoint(event);
      const lane = this.buyLaneFromSwipe(start, point);
      if (lane) {
        this.onCommand({ type: "buy", lane, unit: start.type });
      }
      return;
    }
    if (!this.drag) {
      if ((this.winner || this.status !== "playing")) {
        return;
      }
      const town = this.hitCheckpoint(event);
      if (town && town.owner === "player") {
        this.onCommand({ type: "upgrade", checkpointId: town.index });
      }
      return;
    }
    const start = this.drag;
    this.drag = null;
    if ((this.winner || this.status !== "playing") || start.troop.hp <= 0) {
      return;
    }
    const point = this.canvasPoint(event);
    const pulled = distance(start, point);
    const troopId = start.troop.id;
    const intent = this.dragIntent(start.troop, start, point);
    // Row changes commit once the pointer has crossed into the highlighted
    // sublane. The longer drag minimum is for charge and fallback only;
    // that screen-pixel floor is wider than one row when the board is scaled down.
    if (intent.kind === "lane" && pulled >= CONFIG.laneDragMin) {
      this.announceOrder(start.troop, "lane");
      this.onCommand({ type: "order", troopId, action: "lane", sublane: intent.row });
      return;
    }
    if (pulled >= this.uiMetrics().dragMin) {
      if (intent.kind === "fallback") {
        this.announceOrder(start.troop, "fallback");
        this.onCommand({ type: "order", troopId, action: "fallback" });
        return;
      }
      if (intent.kind === "charge") {
        this.announceOrder(start.troop, "charge");
        this.onCommand({ type: "order", troopId, action: "charge" });
        return;
      }
    }
    this.announceOrder(start.troop, "cycle");
    this.onCommand({ type: "order", troopId, action: "cycle" });
  },

  /**
   * Classify a drag as a row change, a forward charge, or a fallback.
   * Along-the-path wins over a slight sideways drift.
   */
  dragIntent(troop, from, to) {
    const tan = Path.tangentAt(Path.waypoints(troop.side.id, troop.lane, troop.sublane), troop.progress);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const along = dx * tan.x + dy * tan.y;
    const across = dx * -tan.y + dy * tan.x;
    const row = Path.closestSublane(troop.side.id, troop.lane, troop.progress, to);
    if (Math.abs(across) > Math.abs(along) && row !== troop.sublane) {
      return { kind: "lane", row };
    }
    if (along > 0) {
      return { kind: "charge" };
    }
    if (along < 0) {
      return { kind: "fallback" };
    }
    return { kind: "none" };
  },

  /**
   * A buy press becomes a lane only when the pointer travels farther
   * up or down than sideways. Up builds on the top lane.
   */
  buyLaneFromSwipe(start, point) {
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const min = Math.max(16, this.uiMetrics().buyH * 0.55);
    if (Math.abs(dy) < min || Math.abs(dy) <= Math.abs(dx)) {
      return null;
    }
    return dy < 0 ? "top" : "bottom";
  },
};

export function bindInput(board) {
  Object.assign(board, pointerMethods);
  const canvas = board.canvas;
  const opts = { passive: false };
  canvas.addEventListener("pointerdown", (event) => {
    unlockAudio();
    board.onPointerDown(event);
  }, opts);
  canvas.addEventListener("pointermove", (event) => board.onPointerMove(event), opts);
  canvas.addEventListener("pointerup", (event) => board.onPointerUp(event), opts);
  canvas.addEventListener("pointercancel", () => {
    board.drag = null;
    board.buyDrag = null;
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
}
