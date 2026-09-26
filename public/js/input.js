import { CONFIG } from "../shared/config.js";
import { UNIT_VARIANTS } from "../shared/units.js";
import { Path, distance } from "../shared/path.js";
import { unlockAudio } from "./audio.js";

/** Hold this long on one unit to select only that unit (not its line). */
const SELECT_HOLD_MS = 400;
/** Two-finger spread / squeeze past this ratio counts as zoom in / out. */
const PINCH_OUT = 1.12;
const PINCH_IN = 0.88;

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
          const meleeSolo = this.isTroopInMelee(troop);
          this.drag = {
            troop,
            x: world.x,
            y: world.y,
            hx: world.x,
            hy: world.y,
            ux: troop.x,
            uy: troop.y,
            downAt: performance.now(),
            soloPick: meleeSolo,
            wasSelected,
          };
          if (meleeSolo) this.selectTroop(troop, true);
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
    const strategy = this.hitStrategyAt(point);
    if (strategy) {
      this.strategyDrag = {
        lane: strategy.lane,
        x: point.x,
        y: point.y,
        hx: point.x,
        hy: point.y,
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
    const meleeSolo = this.isTroopInMelee(troop);
    this.drag = {
      troop,
      x: point.x,
      y: point.y,
      hx: point.x,
      hy: point.y,
      ux: troop.x,
      uy: troop.y,
      downAt: performance.now(),
      soloPick: meleeSolo,
      wasSelected,
    };
    if (meleeSolo) this.selectTroop(troop, true);
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
    if (this.strategyDrag) {
      this.strategyDrag.hx = point.x;
      this.strategyDrag.hy = point.y;
    }
    if (this.drag) {
      this.drag.hx = point.x;
      this.drag.hy = point.y;
    }
    const overUI = this.hitBuyAt(point)
      || this.hitStrategyAt(point)
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
            this.onCommand({ type: "townProduce", checkpointId: town.index });
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
    if (this.strategyDrag) {
      const start = this.strategyDrag;
      this.strategyDrag = null;
      if (this.winner || this.status !== "playing") {
        return;
      }
      const point = this.canvasPoint(event);
      const swipe = this.strategySwipeDir(start, point);
      // Click or swipe right → forward; swipe left → back.
      const dir = swipe === -1 ? -1 : 1;
      const mode = this.nextTargetingMode(start.lane, dir);
      if (!this.player.targeting) {
        this.player.targeting = { top: "bastion", bottom: "bastion" };
      }
      this.player.targeting[start.lane] = mode;
      this.onCommand({ type: "targeting", lane: start.lane, mode });
      return;
    }
    if (!this.drag) {
      if ((this.winner || this.status !== "playing")) {
        return;
      }
      const town = this.hitCheckpoint(event);
      if (town && town.owner === "player") {
        this.onCommand({ type: "townProduce", checkpointId: town.index });
      }
      return;
    }
    const start = this.drag;
    this.drag = null;
    if ((this.winner || this.status !== "playing") || start.troop.hp <= 0) {
      return;
    }
    const point = this.worldPoint(event);
    const troop = start.troop;
    const pulled = this.dragPullFromUnit(start, point, troop);
    const orderMin = this.orderDragMin();
    const friendly = troop.side && troop.side.id === "player";

    // Long-press without a drag: already solo-selected; nothing more to do.
    if (start.soloPick && pulled < orderMin) {
      return;
    }

    const intent = this.dragIntent(troop, start, point);
    // Interacting with a different unit leaves solo and selects that line.
    if (friendly && this.inspectedSolo && this.inspectedId != null
      && this.inspectedId !== troop.id) {
      this.selectTroop(troop, false);
    }
    const solo = this.orderSolo(troop, start);

    if (this.directOrders && friendly) {
      this.releaseDirectOrder(troop, start, point, pulled, intent);
      return;
    }

    // Across: change sublane (friendlies only).
    if (friendly && intent.kind === "lane" && pulled >= this.laneDragMin()) {
      this.selectTroop(troop, solo);
      this.announceOrder(troop, "lane");
      this.onCommand({
        type: "order",
        troopId: troop.id,
        action: "lane",
        sublane: intent.row,
        solo,
      });
      return;
    }

    // Along: one step on the speed ladder (retreat / fallback / halt / advance / charge).
    if (friendly && pulled >= orderMin && (intent.kind === "charge" || intent.kind === "fallback")) {
      this.selectTroop(troop, solo);
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
   * Long-press pulls a unit out of its line; later clicks and swipes on
   * that unit stay solo until another unit is clicked (line select).
   * Forward charges, or advances when halted. Back falls back, or
   * advances when charging. A solo unit slides to the row the swipe
   * ends on; a line steps one row together.
   */
  releaseDirectOrder(troop, start, point, pulled, intent) {
    const orderMin = this.orderDragMin();
    if (start.soloPick && pulled < orderMin) {
      return;
    }
    // Clicking a different unit selects its line (exits solo on the prior unit).
    if (this.inspectedSolo && this.inspectedId != null && this.inspectedId !== troop.id) {
      this.selectTroop(troop, false);
    }
    const solo = this.orderSolo(troop, start);
    const shifting = (intent.kind === "lane" || intent.kind === "nudge")
      && pulled >= this.laneDragMin();
    const lineCount = this.lineSizeOf(troop);
    const alone = solo || lineCount < 2;
    if (shifting) {
      if (alone && intent.kind === "lane") {
        this.selectTroop(troop, true);
        this.announceOrder(troop, "switch");
        this.onCommand({
          type: "order",
          troopId: troop.id,
          action: "switch",
          sublane: intent.row,
          solo: true,
        });
        return;
      }
      if (alone) return;
      const dir = intent.dir || this.nudgeDir(troop, start, point);
      if (dir === 0) return;
      this.selectTroop(troop, false);
      this.announceOrder(troop, "switch");
      this.onCommand({
        type: "order",
        troopId: troop.id,
        action: "switch",
        dir,
        solo: false,
      });
      return;
    }
    if (pulled >= orderMin && (intent.kind === "charge" || intent.kind === "fallback")) {
      const action = intent.kind === "charge" ? "forward" : "back";
      this.selectTroop(troop, solo);
      this.announceOrder(troop, action);
      this.onCommand({ type: "order", troopId: troop.id, action, solo });
      return;
    }
    if (pulled < orderMin) {
      // Solo-selected unit: keep solo and issue only to it.
      // Other unit: already line-selected above; issue to that line.
      // No selection yet: select the line and issue.
      if (!this.isInspected(troop)) {
        this.selectTroop(troop, false);
      } else {
        this.selectTroop(troop, solo);
      }
      this.announceOrder(troop, "cycle");
      this.onCommand({
        type: "order",
        troopId: troop.id,
        action: "cycle",
        solo: Boolean(this.inspectedSolo),
      });
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

  /**
   * True when this press should affect only that unit: long-press, melee
   * contact, or the unit is already the solo selection.
   */
  orderSolo(troop, start) {
    if (this.isTroopInMelee(troop)) return true;
    if (start && start.soloPick) return true;
    return Boolean(this.inspectedSolo && this.inspectedId === troop.id);
  },

  /** Drop the current selection without picking another unit. */
  clearSelection() {
    this.inspectedId = null;
    this.inspectedSolo = false;
    this.inspectedLineIds = null;
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
    this.inspectedSolo = Boolean(solo) || this.isTroopInMelee(troop);
    this.inspectedTroop();
  },

  /**
   * Tap an unselected unit to inspect its line (or alone if in melee).
   * Tap the solo-selected unit again to issue a solo order. Tap any other
   * unit to select that unit's line (leaving solo on the previous unit).
   */
  handleUnitTap(troop) {
    const friendly = troop.side && troop.side.id === "player";
    // Another unit: select its line (this is how you leave solo).
    if (this.inspectedId != null && this.inspectedId !== troop.id) {
      this.selectTroop(troop, false);
      return;
    }
    if (!this.isInspected(troop)) {
      this.selectTroop(troop, false);
      return;
    }
    if (!friendly) return;
    const solo = Boolean(this.inspectedSolo) || this.isTroopInMelee(troop);
    if (troop.order === "reform") {
      this.announceOrder(troop, "restore");
      this.onCommand({ type: "order", troopId: troop.id, action: "restore", solo });
      return;
    }
    this.announceOrder(troop, "reform");
    this.onCommand({ type: "order", troopId: troop.id, action: "reform", solo });
  },

  /**
   * Holding still on a unit long enough selects only that unit. Pull is
   * measured relative to the unit so a walking body does not fake a drag,
   * and the hold cancels if the unit leaves the finger.
   */
  refreshHoldSelect() {
    const drag = this.drag;
    if (!drag || !drag.troop || drag.troop.hp <= 0 || drag.downAt == null) {
      return;
    }
    if (drag.soloPick) {
      return;
    }
    if (performance.now() - drag.downAt < SELECT_HOLD_MS) {
      return;
    }
    const troop = drag.troop;
    const finger = { x: drag.hx, y: drag.hy };
    // Unit walked out from under the press — not a hold on that unit.
    if (this.hitAnyTroopAt(finger) !== troop) {
      return;
    }
    if (this.dragPullFromUnit(drag, finger, troop) >= this.orderDragMin()) {
      return;
    }
    drag.soloPick = true;
    this.selectTroop(troop, true);
  },

  /**
   * Pointer travel minus how far the unit moved since press. Holding still
   * while the unit walks counts as leaving it; tracking the unit does not
   * count as a swipe.
   */
  dragPullFromUnit(drag, point, troop) {
    const unitDx = troop.x - (drag.ux == null ? troop.x : drag.ux);
    const unitDy = troop.y - (drag.uy == null ? troop.y : drag.uy);
    const ptrDx = point.x - drag.x;
    const ptrDy = point.y - drag.y;
    return Math.hypot(ptrDx - unitDx, ptrDy - unitDy);
  },

  /** Which neighboring row a short across-swipe is heading toward. */
  nudgeDir(troop, drag, to) {
    const unitDx = troop.x - (drag.ux == null ? troop.x : drag.ux);
    const unitDy = troop.y - (drag.uy == null ? troop.y : drag.uy);
    const dx = (to.x - drag.x) - unitDx;
    const dy = (to.y - drag.y) - unitDy;
    const len = Math.hypot(dx, dy) || 1;
    const reach = Math.max(len, 36);
    const probe = {
      x: troop.x + (dx / len) * reach,
      y: troop.y + (dy / len) * reach,
    };
    const row = Path.closestSublane(troop.side.id, troop.lane, troop.progress, probe);
    return Math.sign(row - troop.sublane);
  },

  /**
   * Classify a drag as a row change, a forward speed-up, or a speed-down.
   * Motion is relative to the unit so tracking a walker is not a swipe.
   * Along-the-path wins over a slight sideways drift.
   */
  dragIntent(troop, drag, to) {
    const tan = Path.tangentAt(Path.waypoints(troop.side.id, troop.lane, troop.sublane), troop.progress);
    const unitDx = troop.x - (drag.ux == null ? troop.x : drag.ux);
    const unitDy = troop.y - (drag.uy == null ? troop.y : drag.uy);
    const dx = (to.x - drag.x) - unitDx;
    const dy = (to.y - drag.y) - unitDy;
    const along = dx * tan.x + dy * tan.y;
    const across = dx * -tan.y + dy * tan.x;
    const row = Path.closestSublane(troop.side.id, troop.lane, troop.progress, to);
    if (Math.abs(across) > Math.abs(along) && row !== troop.sublane) {
      return { kind: "lane", row, dir: Math.sign(row - troop.sublane) };
    }
    if (this.directOrders && Math.abs(across) > Math.abs(along)) {
      return { kind: "nudge", dir: this.nudgeDir(troop, drag, to) };
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
   * Horizontal swipe on a buy button with an alternate.
   * Returns -1 (left) or 1 (right), once past the drag threshold.
   */
  buyVariantFromSwipe(start, point) {
    if (!UNIT_VARIANTS[start.type]) {
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

  /**
   * Horizontal swipe on a grand strategy button.
   * Returns -1 (left) or 1 (right), or null if not past threshold.
   */
  strategySwipeDir(start, point) {
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const box = this.strategyButtonRect(start.lane);
    const min = Math.max(16, box.w * 0.25);
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
  const pointers = new Map();
  const pinchIds = new Set();
  let pinch = null;

  function clearTransientPress() {
    board.drag = null;
    board.buyDrag = null;
    board.strategyDrag = null;
    board.telescopeDrag = null;
    board.telescopeSlide = 0;
    board.lanePress = null;
    board.enemyPress = null;
  }

  function pinchCenterEvent() {
    const pts = [...pointers.values()];
    if (pts.length < 2) return null;
    return {
      clientX: (pts[0].x + pts[1].x) / 2,
      clientY: (pts[0].y + pts[1].y) / 2,
    };
  }

  function pinchDistance() {
    const pts = [...pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  function beginPinch() {
    clearTransientPress();
    for (const id of pointers.keys()) pinchIds.add(id);
    const dist = Math.max(1, pinchDistance());
    const center = pinchCenterEvent();
    pinch = {
      startDist: dist,
      // World under the midpoint when the second finger landed.
      spot: center ? board.nearestLaneAt(board.canvasPoint(center)) : null,
      acted: false,
    };
  }

  function stepPinch() {
    if (!pinch || pinch.acted || pointers.size !== 2) return;
    const ratio = pinchDistance() / pinch.startDist;
    if (ratio >= PINCH_OUT) {
      pinch.acted = true;
      if (!board.telescope && pinch.spot) {
        board.openTelescopeAt(pinch.spot.lane, pinch.spot.along);
      }
    } else if (ratio <= PINCH_IN) {
      pinch.acted = true;
      board.closeTelescope();
    }
  }

  function zoomToward(event, into) {
    if (board.winner || board.status !== "playing" || !board.player) return;
    if (into) {
      if (board.telescope) return;
      const spot = board.nearestLaneAt(board.canvasPoint(event));
      if (spot) board.openTelescopeAt(spot.lane, spot.along);
      return;
    }
    board.closeTelescope();
  }

  canvas.addEventListener("pointerdown", (event) => {
    unlockAudio();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      event.preventDefault();
      pinchIds.add(event.pointerId);
      if (!pinch) beginPinch();
      return;
    }
    board.onPointerDown(event);
  }, opts);
  canvas.addEventListener("pointermove", (event) => {
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinch && pointers.size >= 2) {
      event.preventDefault();
      stepPinch();
      return;
    }
    board.onPointerMove(event);
  }, opts);
  canvas.addEventListener("pointerup", (event) => {
    const fromPinch = pinchIds.has(event.pointerId);
    pointers.delete(event.pointerId);
    pinchIds.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (fromPinch || pointers.size >= 2) {
      event.preventDefault();
      return;
    }
    board.onPointerUp(event);
  }, opts);
  canvas.addEventListener("pointercancel", (event) => {
    pointers.delete(event.pointerId);
    pinchIds.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    clearTransientPress();
  });
  canvas.addEventListener("wheel", (event) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    // Wheel up / trackpad pinch-out → telescope; wheel down / pinch-in → overview.
    zoomToward(event, event.deltaY < 0);
  }, opts);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
}
