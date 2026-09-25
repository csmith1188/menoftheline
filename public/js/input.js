import { CONFIG } from "../shared/config.js";
import { UNIT_VARIANTS } from "../shared/units.js";
import { Path, distance } from "../shared/path.js";
import { unlockAudio } from "./audio.js";

/** Hold this long on one unit to select only that unit (not its line). */
const SELECT_HOLD_MS = 400;

const pointerMethods = {
  /**
   * Press a unit to select, reform/restore, or drag for speed / lane.
   * Enemies can be selected for info only.
   */
  onPointerDown(event) {
    if (!event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (this.telescope) {
      event.preventDefault();
      this.telescopeSlide = 0;
      let enemyTap = null;
      if (!(this.winner || this.status !== "playing")) {
        const world = this.worldPoint(event);
        const troop = this.hitAnyTroopAt(world);
        const friendly = troop && troop.side && troop.side.id === "player";
        if (troop && friendly) {
          const wasSelected = this.isInspected(troop);
          this.drag = {
            troop,
            x: world.x,
            y: world.y,
            hx: world.x,
            hy: world.y,
            downAt: performance.now(),
            soloPick: false,
            wasSelected,
          };
          this.canvas.setPointerCapture(event.pointerId);
          return;
        }
        if (troop) enemyTap = troop.id;
      }
      const point = this.screenPoint(event);
      this.telescopeDrag = {
        x: point.x,
        y: point.y,
        along: this.telescope.along,
        switched: false,
        samples: [{ t: performance.now(), along: this.telescope.along }],
        enemyTap,
      };
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if ((this.winner || this.status !== "playing")) {
      return;
    }
    event.preventDefault();
    const point = this.canvasPoint(event);
    const unlock = this.hitVariantUnlockAt(point);
    if (unlock) {
      if (!this.buySelection) this.buySelection = {};
      this.buySelection[unlock.base] = unlock.variant;
      this.onCommand({ type: "unlockVariant", base: unlock.base });
      return;
    }
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
        variantSwipe: null,
      };
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (this.hitBankAt(point, this.player)) {
      this.onCommand({ type: "bank" });
      return;
    }
    const troop = this.hitAnyTroopAt(point);
    if (!troop) {
      const spot = this.laneAt(point);
      if (spot && !this.hitUnitAt(point)) {
        this.lanePress = { x: point.x, y: point.y, lane: spot.lane, along: spot.along };
        this.canvas.setPointerCapture(event.pointerId);
      }
      return;
    }
    const friendly = troop.side && troop.side.id === "player";
    if (!friendly) {
      const spot = this.laneAt(point);
      if (spot) {
        this.lanePress = {
          x: point.x,
          y: point.y,
          lane: spot.lane,
          along: spot.along,
          enemyTap: troop.id,
        };
      } else {
        this.enemyPress = { x: point.x, y: point.y, enemyTap: troop.id };
      }
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    const wasSelected = this.isInspected(troop);
    this.drag = {
      troop,
      x: point.x,
      y: point.y,
      hx: point.x,
      hy: point.y,
      downAt: performance.now(),
      soloPick: false,
      wasSelected,
    };
    this.canvas.setPointerCapture(event.pointerId);
  },

  /** While dragging, keep the hover point so the target row can light up. */
  onPointerMove(event) {
    if (!event.isPrimary) {
      return;
    }
    event.preventDefault();
    if (this.telescope) {
      if (this.drag) {
        const world = this.worldPoint(event);
        this.drag.hx = world.x;
        this.drag.hy = world.y;
        this.canvas.style.cursor = "pointer";
        return;
      }
      const point = this.screenPoint(event);
      if (this.telescopeDrag) this.moveTelescope(point);
      const world = this.telescopeWorld(point);
      const over = this.hitAnyTroopAt(world) || this.hitCheckpointAt(world);
      this.canvas.style.cursor = over || this.laneAt(world) ? "pointer" : "default";
      return;
    }
    if (!this.player) return;
    const point = this.canvasPoint(event);
    this.hover = point;
    if (this.buyDrag) {
      this.buyDrag.hx = point.x;
      this.buyDrag.hy = point.y;
      this.buyDrag.lane = this.buyLaneFromSwipe(this.buyDrag, point);
      const swipe = this.buyVariantFromSwipe(this.buyDrag, point);
      if (swipe && this.buyDrag.variantSwipe !== swipe) {
        this.buyDrag.variantSwipe = swipe;
        this.cycleBuyVariant(this.buyDrag.type, swipe);
      }
    }
    if (this.drag) {
      this.drag.hx = point.x;
      this.drag.hy = point.y;
    }
    const overUI = this.hitVariantUnlockAt(point)
      || this.hitBuyAt(point)
      || this.hitBankAt(point, this.player);
    this.canvas.style.cursor = overUI ? "pointer" : "default";
  },

  /**
   * Release: click selects / reforms / restores; along-drag changes speed;
   * across-drag changes row; long-press selects only that unit.
   */
  onPointerUp(event) {
    if (!event.isPrimary) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (this.telescopeDrag) {
      const start = this.telescopeDrag;
      const point = this.screenPoint(event);
      const pulled = distance(start, point);
      if (!start.switched && pulled < this.uiMetrics().dragMin) {
        this.telescopeDrag = null;
        this.telescopeSlide = 0;
        const world = this.telescopeWorld(point);
        if (!(this.winner || this.status !== "playing")) {
          const town = this.hitCheckpointAt(world);
          if (town && town.owner === "player") {
            this.onCommand({ type: "upgrade", checkpointId: town.index });
            return;
          }
          const enemy = this.enemyTapTroop(start.enemyTap);
          if (enemy) {
            this.selectTroop(enemy, false);
            return;
          }
        }
        if (!this.laneAt(world)) this.closeTelescope();
        return;
      }
      this.releaseTelescope();
      return;
    }
    if (this.lanePress) {
      const start = this.lanePress;
      this.lanePress = null;
      if (this.winner || this.status !== "playing") return;
      const point = this.canvasPoint(event);
      if (distance(start, point) < this.uiMetrics().dragMin) {
        const enemy = this.enemyTapTroop(start.enemyTap);
        if (enemy) {
          this.selectTroop(enemy, false);
          return;
        }
        if (!this.hitUnitAt(point)) {
          this.openTelescopeAt(start.lane, start.along);
        }
      }
      return;
    }
    if (this.enemyPress) {
      const start = this.enemyPress;
      this.enemyPress = null;
      if (this.winner || this.status !== "playing") return;
      const point = this.canvasPoint(event);
      if (distance(start, point) < this.uiMetrics().dragMin) {
        const enemy = this.enemyTapTroop(start.enemyTap);
        if (enemy) this.selectTroop(enemy, false);
      }
      return;
    }
    if (this.buyDrag) {
      const start = this.buyDrag;
      this.buyDrag = null;
      if (this.winner || this.status !== "playing") {
        return;
      }
      const point = this.canvasPoint(event);
      if (start.variantSwipe) {
        return;
      }
      const lane = this.buyLaneFromSwipe(start, point);
      if (lane) {
        this.onCommand({ type: "buy", lane, unit: this.selectedBuyUnit(start.type) });
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
    const point = this.worldPoint(event);
    const pulled = distance(start, point);
    const troop = start.troop;
    const orderMin = this.orderDragMin();
    const friendly = troop.side && troop.side.id === "player";

    // Long-press without a drag: select only this unit.
    if (start.soloPick && pulled < orderMin) {
      return;
    }

    const intent = this.dragIntent(troop, start, point);

    if (this.directOrders && friendly) {
      this.releaseDirectOrder(troop, start, point, pulled, intent);
      return;
    }

    // Across: change sublane (friendlies only).
    if (friendly && intent.kind === "lane" && pulled >= this.laneDragMin()) {
      this.selectTroop(troop, this.inspectedSolo);
      this.announceOrder(troop, "lane");
      this.onCommand({
        type: "order",
        troopId: troop.id,
        action: "lane",
        sublane: intent.row,
        solo: Boolean(this.inspectedSolo),
      });
      return;
    }

    // Along: one step on the speed ladder (retreat / fallback / halt / advance / charge).
    if (friendly && pulled >= orderMin && (intent.kind === "charge" || intent.kind === "fallback")) {
      if (!this.isInspected(troop)) this.selectTroop(troop, false);
      const solo = Boolean(this.inspectedSolo && this.inspectedId === troop.id);
      const action = intent.kind === "charge" ? "speedUp" : "speedDown";
      this.announceOrder(troop, action);
      this.onCommand({ type: "order", troopId: troop.id, action, solo });
      return;
    }

    // Click: select, or reform / restore when already selected.
    if (pulled < orderMin) {
      this.handleUnitTap(troop);
    }
  },

  /**
   * 2D release: a tap goes straight to halt, then reform, then advance.
   * Issuing an order selects that line. Forward charges, or advances
   * when halted. Back falls back, or advances when charging. A lone
   * selected unit slides to the row the swipe ends on; a line steps
   * one row together.
   */
  releaseDirectOrder(troop, start, point, pulled, intent) {
    const orderMin = this.orderDragMin();
    if (start.soloPick && pulled < orderMin) {
      return;
    }
    const soloUnit = Boolean(this.inspectedSolo && this.inspectedId === troop.id);
    const shifting = (intent.kind === "lane" || intent.kind === "nudge")
      && pulled >= this.laneDragMin();
    const lineCount = this.lineSizeOf(troop);
    const alone = soloUnit || lineCount < 2;
    if (shifting) {
      if (alone && intent.kind === "lane") {
        this.selectTroop(troop, true);
        this.announceOrder(troop, "lane");
        this.onCommand({
          type: "order",
          troopId: troop.id,
          action: "lane",
          sublane: intent.row,
          solo: true,
        });
        return;
      }
      if (alone) return;
      const dir = intent.dir || this.nudgeDir(troop, start, point);
      if (dir === 0) return;
      this.selectTroop(troop, false);
      this.announceOrder(troop, "shift");
      this.onCommand({
        type: "order",
        troopId: troop.id,
        action: "shift",
        dir,
        solo: false,
      });
      return;
    }
    if (pulled >= orderMin && (intent.kind === "charge" || intent.kind === "fallback")) {
      const action = intent.kind === "charge" ? "forward" : "back";
      this.selectTroop(troop, false);
      this.announceOrder(troop, action);
      this.onCommand({ type: "order", troopId: troop.id, action, solo: false });
      return;
    }
    if (pulled < orderMin) {
      this.selectTroop(troop, false);
      this.announceOrder(troop, "cycle");
      this.onCommand({ type: "order", troopId: troop.id, action: "cycle", solo: false });
    }
  },

  /** Living enemy captured at the start of a telescope press, if any. */
  enemyTapTroop(id) {
    if (id == null || !this.enemy) return null;
    for (let i = 0; i < this.enemy.troops.length; i += 1) {
      const troop = this.enemy.troops[i];
      if (troop.id === id && troop.hp > 0) return troop;
    }
    return null;
  },

  /** True when this unit is in the current selection (solo or line). */
  isInspected(troop) {
    return Boolean(this.inspectedLineIds && this.inspectedLineIds[troop.id]);
  },

  /** How many units share this troop's line, without changing the selection. */
  lineSizeOf(troop) {
    const savedId = this.inspectedId;
    const savedSolo = this.inspectedSolo;
    this.selectTroop(troop, false);
    const count = this.inspectedLineIds ? Object.keys(this.inspectedLineIds).length : 1;
    this.inspectedId = savedId;
    this.inspectedSolo = savedSolo;
    this.inspectedTroop();
    return count;
  },

  selectTroop(troop, solo) {
    this.inspectedId = troop.id;
    this.inspectedSolo = Boolean(solo);
    this.inspectedTroop();
  },

  /**
   * Tap an unselected unit to inspect it. Tap a selected friendly again
   * to reform, or to restore the prior speed order while reforming.
   */
  handleUnitTap(troop) {
    const friendly = troop.side && troop.side.id === "player";
    if (!this.isInspected(troop)) {
      this.selectTroop(troop, false);
      return;
    }
    if (!friendly) return;
    const solo = Boolean(this.inspectedSolo);
    if (troop.order === "reform") {
      this.announceOrder(troop, "restore");
      this.onCommand({ type: "order", troopId: troop.id, action: "restore", solo });
      return;
    }
    this.announceOrder(troop, "reform");
    this.onCommand({ type: "order", troopId: troop.id, action: "reform", solo });
  },

  /**
   * Holding still long enough selects only that unit so later speed
   * orders do not spread through its line.
   */
  refreshHoldSelect() {
    const drag = this.drag;
    if (!drag || !drag.troop || drag.troop.hp <= 0 || drag.downAt == null) {
      return;
    }
    if (performance.now() - drag.downAt < SELECT_HOLD_MS) {
      return;
    }
    const pulled = distance(drag, { x: drag.hx, y: drag.hy });
    if (pulled >= this.orderDragMin()) {
      return;
    }
    drag.soloPick = true;
    this.selectTroop(drag.troop, true);
  },

  /** Which neighboring row a short across-swipe is heading toward. */
  nudgeDir(troop, from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const reach = Math.max(len, 36);
    const probe = {
      x: from.x + (dx / len) * reach,
      y: from.y + (dy / len) * reach,
    };
    const row = Path.closestSublane(troop.side.id, troop.lane, troop.progress, probe);
    return Math.sign(row - troop.sublane);
  },

  /**
   * Classify a drag as a row change, a forward speed-up, or a speed-down.
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
      return { kind: "lane", row, dir: Math.sign(row - troop.sublane) };
    }
    if (this.directOrders && Math.abs(across) > Math.abs(along)) {
      return { kind: "nudge", dir: this.nudgeDir(troop, from, to) };
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

  /**
   * Horizontal swipe on a buy button with an unlocked variant.
   * Returns -1 (left) or 1 (right), once past the drag threshold.
   */
  buyVariantFromSwipe(start, point) {
    const key = UNIT_VARIANTS[start.type];
    if (!key || !this.player || !this.player.unlockedVariants[key]) {
      return null;
    }
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const min = Math.max(16, this.uiMetrics().buyW * 0.35);
    if (Math.abs(dx) < min || Math.abs(dx) <= Math.abs(dy)) {
      return null;
    }
    return dx < 0 ? -1 : 1;
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
    board.telescopeDrag = null;
    board.telescopeSlide = 0;
    board.lanePress = null;
    board.enemyPress = null;
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
}
