import { CONFIG } from "../shared/config.js";
import { UNIT_VARIANTS } from "../shared/units.js";
import { Path, distance } from "../shared/path.js";
import { unlockAudio } from "./audio.js";
import {
  clearGestureHints,
  refreshGestureHintActive,
  showBuyHints,
  showStrategyHints,
  showUnitHints,
} from "./tooltips.js";

/** Hold this long on one unit to select only that unit (not its line). */
const SELECT_HOLD_MS = 400;
/** Touch presses often sit near 400ms; require a clearer hold on coarse pointers. */
const SELECT_HOLD_TOUCH_MS = 800;
/** Hold this long on a buy button (no swipe) to open the unit info overlay. */
const BUY_INFO_HOLD_MS = 1200;
/** Two-finger spread / squeeze past this ratio counts as zoom in / out. */
const PINCH_OUT = 1.12;
const PINCH_IN = 0.88;

function selectHoldMs(board) {
  return board && typeof board.isTouchUi === "function" && board.isTouchUi()
    ? SELECT_HOLD_TOUCH_MS
    : SELECT_HOLD_MS;
}

function isBoardPointer(board, event) {
  if (board.activePointerId == null) return Boolean(event.isPrimary);
  return event.pointerId === board.activePointerId;
}

const pointerMethods = {
  /**
   * Press a unit to select, reform/restore, or drag for speed / lane.
   * Enemies can be selected for info only.
   */
  onPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      // Right-click matches a completed long-press: solo-select that unit.
      if (event.button === 2) this.onRightClickSolo(event);
      return;
    }
    // bindInput only forwards the gesture finger; still ignore a stray second id.
    if (this.activePointerId != null && event.pointerId !== this.activePointerId) return;
    this.activePointerId = event.pointerId;
    if (this.telescope) {
      event.preventDefault();
      this.telescopeSlide = 0;
      let enemyTap = null;
      if (!(this.winner || this.status !== "playing")) {
        if (this.hitBankAt(this.canvasPoint(event), this.player)) {
          this.onCommand({ type: "bank" });
          return;
        }
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
          showUnitHints(this, troop);
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
        downAt: performance.now(),
        infoOpened: false,
      };
      showBuyHints(this, buy.type, this.buyButtonRect(buy.index));
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
        swipe: null,
      };
      showStrategyHints(this, this.strategyButtonRect(strategy.lane));
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
    showUnitHints(this, troop);
    this.canvas.setPointerCapture(event.pointerId);
  },

  /**
   * Right-click activates the same solo pick as a finished long-press, then
   * allows the usual swipe orders on only that unit.
   */
  onRightClickSolo(event) {
    if (this.winner || this.status !== "playing") return;
    event.preventDefault();
    let troop = null;
    let point = null;
    if (this.telescope) {
      if (this.hitBankAt(this.canvasPoint(event), this.player)) return;
      point = this.worldPoint(event);
      troop = this.hitAnyTroopAt(point);
    } else {
      point = this.canvasPoint(event);
      if (this.hitBuyAt(point) || this.hitStrategyAt(point)
        || this.hitBankAt(point, this.player)) {
        return;
      }
      troop = this.hitAnyTroopAt(point);
    }
    if (!troop || !troop.side || troop.side.id !== "player") return;
    const wasSelected = this.isInspected(troop);
    this.drag = {
      troop,
      x: point.x,
      y: point.y,
      hx: point.x,
      hy: point.y,
      ux: troop.x,
      uy: troop.y,
      downAt: performance.now(),
      soloPick: true,
      wasSelected,
    };
    this.selectTroop(troop, true);
    this.canvas.setPointerCapture(event.pointerId);
  },

  /** While dragging, keep the hover point so the target row can light up. */
  onPointerMove(event) {
    if (!isBoardPointer(this, event)) {
      return;
    }
    event.preventDefault();
    if (this.telescope) {
      if (this.drag) {
        const world = this.worldPoint(event);
        this.drag.hx = world.x;
        this.drag.hy = world.y;
        refreshGestureHintActive(this);
        this.canvas.style.cursor = "pointer";
        return;
      }
      const point = this.screenPoint(event);
      if (this.telescopeDrag) this.moveTelescope(point);
      const world = this.telescopeWorld(point);
      const overBank = this.hitBankAt(this.canvasPoint(event), this.player);
      const over = this.hitAnyTroopAt(world) || this.hitCheckpointAt(world);
      this.canvas.style.cursor = overBank || over || this.laneAt(world) ? "pointer" : "default";
      return;
    }
    if (!this.player) return;
    const point = this.canvasPoint(event);
    this.hover = point;
    if (this.buyDrag) {
      this.buyDrag.hx = point.x;
      this.buyDrag.hy = point.y;
      if (!this.buyDrag.infoOpened) {
        this.buyDrag.lane = this.buyLaneFromSwipe(this.buyDrag, point);
        this.buyDrag.variantSwipe = this.buyVariantFromSwipe(this.buyDrag, point);
        refreshGestureHintActive(this);
      }
    }
    if (this.strategyDrag) {
      this.strategyDrag.hx = point.x;
      this.strategyDrag.hy = point.y;
      this.strategyDrag.swipe = this.strategySwipeDir(this.strategyDrag, point);
      refreshGestureHintActive(this);
    }
    if (this.drag) {
      this.drag.hx = point.x;
      this.drag.hy = point.y;
      refreshGestureHintActive(this);
    }
    const overUI = this.hitBuyAt(point)
      || this.hitStrategyAt(point)
      || this.hitBankAt(point, this.player);
    this.canvas.style.cursor = overUI ? "pointer" : "default";
  },

  /**
   * Release: click selects / reforms / restores; along-drag changes speed;
   * across-drag changes row; long-press / right-click selects only that unit.
   */
  onPointerUp(event) {
    if (!isBoardPointer(this, event)) {
      return;
    }
    this.activePointerId = null;
    clearGestureHints(this);
    const rightRelease = event.pointerType === "mouse" && event.button === 2;
    if (event.pointerType === "mouse" && event.button !== 0) {
      // Only finish a right-click solo drag; ignore other mouse buttons.
      if (!rightRelease || !this.drag) return;
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
      if (start.infoOpened) return;
      if (this.winner || this.status !== "playing") {
        return;
      }
      const point = this.canvasPoint(event);
      const swipe = this.buyVariantFromSwipe(start, point);
      if (swipe) {
        this.cycleBuyVariant(start.type, swipe);
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
      if (!swipe) return;
      const mode = this.nextTargetingMode(start.lane, swipe);
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
    // Melee may set soloPick on down — that must not swallow the tap order.
    if (start.holdSolo && pulled < orderMin) {
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
   * Long-press / right-click pulls a unit out of its line; later clicks and swipes on
   * that unit stay solo until another unit is clicked (line select).
   * Forward charges, or advances when halted. Back falls back, or
   * advances when charging. A solo unit slides to the row the swipe
   * ends on; a line steps one row together.
   */
  releaseDirectOrder(troop, start, point, pulled, intent) {
    const orderMin = this.orderDragMin();
    if (start.holdSolo && pulled < orderMin) {
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
        const dir = intent.dir || Math.sign(intent.row - troop.sublane);
        if (dir !== 1 && dir !== -1) return;
        this.selectTroop(troop, true);
        this.announceOrder(troop, "switch", dir);
        this.onCommand({
          type: "order",
          troopId: troop.id,
          action: "switch",
          dir,
          solo: true,
        });
        return;
      }
      if (alone) return;
      const dir = intent.dir || this.nudgeDir(troop, start, point);
      if (dir === 0) return;
      this.selectTroop(troop, false);
      this.announceOrder(troop, "switch", dir);
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
   * True when this press should affect only that unit: long-press, right-click,
   * melee contact, or the unit is already the solo selection.
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
    const savedLines = this.inspectedLineIds;
    this.selectTroop(troop, false);
    const count = this.inspectedLineIds ? Object.keys(this.inspectedLineIds).length : 1;
    this.inspectedId = savedId;
    this.inspectedSolo = savedSolo;
    this.inspectedLineIds = savedLines;
    return count;
  },

  selectTroop(troop, solo) {
    this.inspectedId = troop.id;
    this.inspectedSolo = Boolean(solo) || this.isTroopInMelee(troop);
    this.captureInspectedLine(troop);
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
   * Holding still on a unit long enough selects only that unit (same as
   * right-click). Pull is measured relative to the unit so a walking body
   * does not fake a drag, and the hold cancels if the unit leaves the finger.
   */
  refreshHoldSelect() {
    this.refreshBuyInfoHold();
    const drag = this.drag;
    if (!drag || !drag.troop || drag.troop.hp <= 0 || drag.downAt == null) {
      return;
    }
    if (!drag.holdSolo
        && performance.now() - drag.downAt >= selectHoldMs(this)) {
      const troop = drag.troop;
      const finger = { x: drag.hx, y: drag.hy };
      // Unit walked out from under the press — not a hold on that unit.
      if (this.hitAnyTroopAt(finger) === troop
          && this.dragPullFromUnit(drag, finger, troop) < this.orderDragMin()) {
        drag.holdSolo = true;
        drag.soloPick = true;
        this.selectTroop(troop, true);
      }
    }
    if (this.gestureHints) refreshGestureHintActive(this);
  },

  /**
   * Hold still on a buy button to open the unit info overlay. Any swipe past
   * the deploy / variant threshold cancels the hold.
   */
  refreshBuyInfoHold() {
    const drag = this.buyDrag;
    if (!drag || drag.infoOpened || drag.downAt == null) return;
    const point = { x: drag.hx, y: drag.hy };
    if (this.buyLaneFromSwipe(drag, point) || this.buyVariantFromSwipe(drag, point)) {
      return;
    }
    if (performance.now() - drag.downAt < BUY_INFO_HOLD_MS) return;
    drag.infoOpened = true;
    clearGestureHints(this);
    const spawn = this.selectedBuyUnit(drag.type);
    if (typeof this.onBuyInfo === "function") this.onBuyInfo(spawn);
  },

  /**
   * Pointer travel from the press point. Unit motion is ignored so holding
   * still on a walker does not become charge or fallback.
   */
  dragPullFromUnit(drag, point, _troop) {
    return Math.hypot(point.x - drag.x, point.y - drag.y);
  },

  /** Which neighboring row a short across-swipe is heading toward. */
  nudgeDir(troop, drag, to) {
    const dx = to.x - drag.x;
    const dy = to.y - drag.y;
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
   * Motion is from the initial press so a held finger on a walker is idle.
   * Along-the-path wins over a slight sideways drift.
   */
  dragIntent(troop, drag, to) {
    const tan = Path.tangentAt(Path.waypoints(troop.side.id, troop.lane, troop.sublane), troop.progress);
    const dx = to.x - drag.x;
    const dy = to.y - drag.y;
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
   * Neighboring row a lane-switch drag would step into. Swipes only move
   * one row, so this is not the row under the cursor when it overshoots.
   */
  switchHoverRow() {
    if (!this.drag || !this.drag.troop || this.drag.troop.hp <= 0) return null;
    const troop = this.drag.troop;
    const point = { x: this.drag.hx, y: this.drag.hy };
    if (this.dragPullFromUnit(this.drag, point, troop) < this.laneDragMin()) {
      return null;
    }
    const intent = this.dragIntent(troop, this.drag, point);
    if (intent.kind !== "lane" && intent.kind !== "nudge") return null;
    const dir = intent.dir;
    if (dir !== 1 && dir !== -1) return null;
    const row = troop.sublane + dir;
    if (row < 0 || row >= Path.sublaneCount(troop.lane)) return null;
    return row;
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
    if (this.trainingMode) {
      return dy > 0 ? "bottom" : null;
    }
    return dy < 0 ? "top" : "bottom";
  },

  /**
   * Horizontal swipe on a buy button with an alternate.
   * Returns -1 (left) or 1 (right), once past the drag threshold.
   */
  buyVariantFromSwipe(start, point) {
    if (!(UNIT_VARIANTS[start.type] && UNIT_VARIANTS[start.type].length)) {
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
  /** Pointer ids that participated in an acted pinch (gesture was consumed). */
  const pinchIds = new Set();
  let pinch = null;
  /** First finger that owns the board gesture (buy/drag/tap). */
  let gesturePointerId = null;

  function clearTransientPress() {
    board.drag = null;
    board.buyDrag = null;
    board.strategyDrag = null;
    board.telescopeDrag = null;
    board.telescopeSlide = 0;
    board.lanePress = null;
    board.enemyPress = null;
    board.activePointerId = null;
    clearGestureHints(board);
  }

  function hasActiveBoardGesture() {
    return Boolean(
      board.drag
      || board.buyDrag
      || board.strategyDrag
      || board.telescopeDrag
      || board.lanePress
      || board.enemyPress,
    );
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

  function watchPinch() {
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
    if (ratio < PINCH_OUT && ratio > PINCH_IN) return;
    // Only now consume the primary press — brief palm/2nd-finger touches stay taps.
    pinch.acted = true;
    clearTransientPress();
    gesturePointerId = null;
    for (const id of pointers.keys()) pinchIds.add(id);
    if (ratio >= PINCH_OUT) {
      if (!board.telescope && pinch.spot) {
        board.openTelescopeAt(pinch.spot.lane, pinch.spot.along);
      }
    } else {
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

  function finishPointer(event, { complete }) {
    const id = event.pointerId;
    const fromPinch = pinchIds.has(id);
    pointers.delete(id);
    pinchIds.delete(id);
    if (pointers.size < 2) pinch = null;

    if (fromPinch) {
      event.preventDefault();
      return;
    }
    if (id !== gesturePointerId) return;
    gesturePointerId = null;
    if (complete) board.onPointerUp(event);
    else clearTransientPress();
  }

  canvas.addEventListener("pointerdown", (event) => {
    unlockAudio();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      event.preventDefault();
      if (!pinch) watchPinch();
      return;
    }
    gesturePointerId = event.pointerId;
    board.onPointerDown(event);
  }, opts);
  canvas.addEventListener("pointermove", (event) => {
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinch && pointers.size >= 2) {
      event.preventDefault();
      stepPinch();
      // Freeze the primary drag while a second finger is down (until pinch acts or ends).
      return;
    }
    board.onPointerMove(event);
  }, opts);
  canvas.addEventListener("pointerup", (event) => {
    finishPointer(event, { complete: true });
  }, opts);
  // iOS edge swipes / capture loss: complete as a tap/swipe instead of dropping the press.
  canvas.addEventListener("pointercancel", (event) => {
    finishPointer(event, { complete: true });
  });
  canvas.addEventListener("lostpointercapture", (event) => {
    if (event.pointerId !== gesturePointerId) return;
    if (!hasActiveBoardGesture()) return;
    finishPointer(event, { complete: true });
  });
  canvas.addEventListener("wheel", (event) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    // Wheel up / trackpad pinch-out → telescope; wheel down / pinch-in → overview.
    zoomToward(event, event.deltaY < 0);
  }, opts);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
}
