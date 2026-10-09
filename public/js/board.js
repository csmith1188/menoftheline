import { CONFIG, pointerHitReach } from "../shared/config.js";
import { BUY_UNITS, UNIT_LABELS, UNIT_STATS, cycleVariantPick, massTaxOf, unitStats, variantOptions } from "../shared/units.js";
import {
  Path,
  distance,
  pointToSegment,
} from "../shared/path.js";
import { TERRAIN_EMOJI, terrainCoverParts } from "../shared/terrain.js";
import { installMapView, isArcLane, isLineLane } from "./mapView.js";
import { SHOT_SNAP_PX, SNAP_PX, lerpAlpha, lerpPoint, lerpTroop } from "./interp.js";

/** Display face for titles. Body copy and bullets use IM Fell English. */
export const FONT_HEADER = "Cinzel";
export const FONT_TEXT = "IM Fell English";

export function canvasFont(px, weight = "bold", role = "text") {
  const name = role === "header" ? FONT_HEADER : FONT_TEXT;
  return `${weight} ${Math.round(px)}px "${name}", Palatino, serif`;
}

let uiFontState = "pending";
const uiFontWaiters = [];

function finishUiFonts() {
  if (uiFontState === "ready") return;
  uiFontState = "ready";
  const waiters = uiFontWaiters.splice(0);
  for (let i = 0; i < waiters.length; i += 1) waiters[i]();
}

function facesReady() {
  return document.fonts.check(`16px "${FONT_HEADER}"`)
    && document.fonts.check(`16px "${FONT_TEXT}"`);
}

function settleUiFonts(triesLeft) {
  if (facesReady() || triesLeft <= 0) {
    finishUiFonts();
    return;
  }
  setTimeout(() => settleUiFonts(triesLeft - 1), 150);
}

/** True once Cinzel and IM Fell English can be drawn, or the load has settled. */
export function uiFontsReady() {
  if (uiFontState === "ready") return true;
  if (typeof document === "undefined" || !document.fonts) {
    finishUiFonts();
    return true;
  }
  if (facesReady()) {
    finishUiFonts();
    return true;
  }
  if (uiFontState === "pending") {
    uiFontState = "loading";
    Promise.all([
      document.fonts.load(`700 32px "${FONT_HEADER}"`),
      document.fonts.load(`400 32px "${FONT_TEXT}"`),
      document.fonts.load(`700 32px "${FONT_TEXT}"`),
    ]).then(() => settleUiFonts(20)).catch(() => settleUiFonts(20));
  }
  return false;
}

export function whenUiFontsReady(fn) {
  if (uiFontsReady()) fn();
  else uiFontWaiters.push(fn);
}

/** Per-lane grand strategy cycle (Bastion → Attrition → Terror). */
export const TARGETING_MODES = ["bastion", "attrition", "terror"];

export const TARGETING_LABELS = {
  bastion: "Bastion",
  attrition: "Attrition",
  terror: "Terror",
};

/** +12 or −1.2, one decimal when the tenth place is nonzero. */
function formatSignedRate(n) {
  const rounded = Math.round(n * 10) / 10;
  const abs = Math.abs(rounded);
  const text = Number.isInteger(rounded) ? String(abs) : abs.toFixed(1);
  return `${rounded < 0 ? "−" : "+"}${text}`;
}

export const troopStateMethods = {
  bodyRadius() {
    if (this.radius) return this.radius;
    return unitStats(this.variant || this.type).radius;
  },

  maxHP() {
    if (this.maxHp) return this.maxHp;
    return unitStats(this.variant || this.type).hp;
  },

  /** Direction along this unit's lane, in view space. */
  laneTangent() {
    const points = Path.waypoints(this.side.id, this.lane, this.sublane);
    return Path.tangentAt(points, this.progress || 0);
  },
};

export const townStateMethods = {
  /** Outer pair defense, next pair speed, middle damage. Same kinds share progress. */
  upgradeKind() {
    const last = CONFIG.checkpointCount - 1;
    const dist = Math.min(this.index, last - this.index);
    if (dist === 0) {
      return "armor";
    }
    if (dist === 1) {
      return "speed";
    }
    return "damage";
  },

  /** Drawn town size follows the UI scale. */
  radius() {
    return CONFIG.checkpointRadius * CONFIG.uiScale;
  },

};

export const sideStateMethods = {
  upgradeCost(kind) {
    return CONFIG.upgradeBaseCost + CONFIG.upgradeCostStep * this.upgrades[kind];
  },

  /** Land still needed to finish the next rank of this upgrade. */
  upgradeRemaining(kind) {
    if (this.upgrades[kind] === undefined || this.upgrades[kind] >= CONFIG.upgradeMax) {
      return 0;
    }
    return Math.max(0, this.upgradeCost(kind) - (this.upgradeProgress[kind] || 0));
  },

  /** True when this upgrade is below the tier cap. */
  canBuyUpgrade(kind) {
    return this.upgrades[kind] !== undefined && this.upgrades[kind] < CONFIG.upgradeMax;
  },

  /** Incoming damage multiplier after armor ranks. */
  armorReduction() {
    return Math.min(CONFIG.armorCap, CONFIG.armorPerUpgrade * this.upgrades.armor);
  },

  /** Outgoing damage multiplier from damage ranks. */
  damageScale() {
    return 1 + CONFIG.damageUpgradeAmount * this.upgrades.damage;
  },

  /** Gold per second paid to keep this side's living units. */
  massTax() {
    return massTaxOf(this.troops);
  },

  /** Gold per second from unlocked banks. Matches the server formula. */
  bankIncome() {
    return CONFIG.bankIncomePer * this.banks;
  },

  /** Top-lane gold share already folded into income, after rounding. */
  laneBonus() {
    return this.income - CONFIG.baseIncome - this.bankIncome();
  },

  /** Gold per second after upkeep. This is the rate the treasury actually changes. */
  netIncome() {
    return this.income - this.massTax();
  },

  /** Signed gold-per-second for the top scoreboard count, tax included. */
  goldRateLabel() {
    return `${formatSignedRate(this.netIncome())}/s`;
  },

  /** Net land per second after town upgrade investment. */
  landRateLabel() {
    const invest = this.landInvestRate || 0;
    return `${formatSignedRate(this.landIncome - invest)}/s`;
  },

  /** Lane bonus, bank income, upkeep, and town research land drain. */
  economyDetail() {
    const tax = Math.round(this.massTax() * 10) / 10;
    const taxText = Number.isInteger(tax) ? String(tax) : tax.toFixed(1);
    const invest = Math.round((this.landInvestRate || 0) * 10) / 10;
    const investText = Number.isInteger(invest) ? String(invest) : invest.toFixed(1);
    return `${formatSignedRate(this.laneBonus())}💰  ${formatSignedRate(this.bankIncome())}🏛️  −${taxText}💰  −${investText}🌿`;
  },

  /**
   * Speed, damage, and armor rows for the centered upgrade HUD.
   * Icons sit in the middle; each side draws only its `text`.
   */
  upgradeRows() {
    return [
      { icon: "⚡", text: `${this.speedMultiplier.toFixed(2)}x` },
      { icon: "⚔️", text: `${this.damageScale().toFixed(2)}x` },
      { icon: "🛡️", text: `${Math.round(this.armorReduction() * 100)}%` },
    ];
  },

  /** Speed, damage, and armor ranks as separate lines (icon on the right). */
  upgradeLines() {
    return this.upgradeRows().map((row) => `${row.text} ${row.icon}`);
  },

  /** Speed, damage, and armor ranks, stacked for the upgrade HUD. */
  upgradeLabel() {
    return this.upgradeLines().join("\n");
  },

  /** Gold to unlock the next bank. */
  bankCost() {
    return CONFIG.bankBaseCost + CONFIG.bankCostStep * this.banks;
  },

  /** World box of one bank button above this capital, kept inside the keep. */
  bankButtonRect(index) {
    const ui = this.board.uiMetrics();
    const scale = this.id === "enemy" ? CONFIG.enemyBankScale : 1;
    const size = ui.bank * scale;
    const gap = ui.bankGap * scale;
    const count = CONFIG.bankCount;
    const total = count * size + (count - 1) * gap;
    const edge = CONFIG.capitalRadius;
    let x;
    if (this.id === "player") {
      x = this.capital.x - edge + index * (size + gap);
    } else {
      const gearCss = 48;
      const reserve = Math.max(
        CONFIG.gearReserve,
        gearCss / (this.board.cssScale || 1),
      );
      const right = Math.min(this.capital.x + edge, CONFIG.canvasWidth - reserve);
      x = right - total + index * (size + gap);
    }
    const y = 8;
    return { x, y, w: size, h: size };
  },

  /** True when match time has reached this bank's unlock minute. */
  bankUnlockedByTime(index) {
    const at = CONFIG.bankUnlockAt[index];
    return at !== undefined && this.board.elapsed >= at;
  },

  /** Remaining time until this bank's unlock, as m:ss. */
  bankCooldownLabel(index) {
    const at = CONFIG.bankUnlockAt[index] || 0;
    const left = Math.max(0, at - this.board.elapsed);
    const m = Math.floor(left / 60);
    const s = Math.floor(left % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  },
};

export const boardStateMethods = {
  isTouchUi() {
    return window.matchMedia("(pointer: coarse)").matches
      || (navigator.maxTouchPoints || 0) > 0;
  },

  /**
   * Cap backing-store DPR. Touch (incl. old iPads) stays at 1× so fog/terrain
   * strokes stay affordable on A8X-class GPUs; desktop may use up to 2×.
   */
  devicePixelRatio() {
    const raw = window.devicePixelRatio || 1;
    return Math.min(raw, this.isTouchUi() ? 1 : 2);
  },

  uiFont(px, weight, role) {
    return canvasFont(px * CONFIG.uiScale, weight || "bold", role);
  },

  /**
   * Glide the drawn lane lines toward the latest snapshot share.
   * Gold and land labels on the line read these values.
   */
  presentLaneCenters(now = performance.now()) {
    const last = this.laneCenterLastAt || now;
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    this.laneCenterLastAt = now;
    const tau = CONFIG.laneCenterEase;
    const k = !(tau > 0) || dt <= 0 ? 1 : 1 - Math.exp(-dt / tau);
    if (!this.laneCenters) this.laneCenters = {};
    if (!this.laneCentersTo) this.laneCentersTo = {};
    const ids = Path.laneIds();
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      let cur = this.laneCenters[id];
      let to = this.laneCentersTo[id];
      if (cur == null) cur = 0.5;
      if (to == null) to = cur;
      cur += (to - cur) * k;
      if (Math.abs(to - cur) < 1e-4) cur = to;
      this.laneCenters[id] = cur;
    }
    if (this.laneCenters.top != null) this.topCenter = this.laneCenters.top;
    if (this.laneCenters.bottom != null) this.bottomCenter = this.laneCenters.bottom;
    if (this.laneCentersTo.top != null) this.topCenterTo = this.laneCentersTo.top;
    if (this.laneCentersTo.bottom != null) this.bottomCenterTo = this.laneCentersTo.bottom;
  },

  /** Drawn control sizes plus extra hit padding so taps reach 44 CSS px. */
  uiMetrics() {
    const scale = this.cssScale || 1;
    const grow = CONFIG.uiScale;
    const tap = CONFIG.touchTargetPx / scale;
    const coarse = this.isTouchUi();
    const buyH = (coarse
      ? Math.min(48, Math.max(CONFIG.buyButtonH, tap * 0.9))
      : CONFIG.buyButtonH) * grow;
    const buyW = CONFIG.buyButtonW * grow;
    const bank = (coarse
      ? Math.min(46, Math.max(CONFIG.bankButtonSize, tap * 0.65))
      : CONFIG.bankButtonSize) * grow;
    const zoom = this.telescope ? this.telescopeScale(this.telescope.lane) : 1;
    const reachOpts = {
      cssScale: scale,
      zoom,
      coarse,
      telescope: Boolean(this.telescope),
    };
    return {
      buyW,
      buyH,
      buyGap: (coarse ? 8 : CONFIG.buyButtonGap) * grow,
      bank,
      bankGap: (coarse ? 8 : CONFIG.bankButtonGap) * grow,
      hitPad: Math.max(6, (CONFIG.touchTargetPx / scale - Math.min(buyH, bank)) / 2),
      unitReach: pointerHitReach({ ...reachOpts, kind: "unit" }),
      townReach: pointerHitReach({ ...reachOpts, kind: "town" }),
      dragMin: Math.max(CONFIG.laneDragMin, 20 / scale),
    };
  },

  pointInBox(point, box, pad) {
    const extra = pad || 0;
    return point.x >= box.x - extra && point.x <= box.x + box.w + extra
      && point.y >= box.y - extra && point.y <= box.y + box.h + extra;
  },

  /**
   * Map a pointer onto logical canvas pixels (CSS size and DPR independent).
   * Southpaw draws a mirrored board, so the point is flipped back into the
   * unmirrored view the rest of the input code uses.
   */
  canvasPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    let x = (event.clientX - rect.left) * (CONFIG.canvasWidth / rect.width);
    const y = (event.clientY - rect.top) * (CONFIG.canvasHeight / rect.height);
    if (this.southpaw) x = CONFIG.canvasWidth - x;
    return { x, y };
  },

  /** World coordinates under the pointer. Undoes the telescope camera when zoomed. */
  worldPoint(event) {
    if (!this.telescope) return this.canvasPoint(event);
    return this.telescopeWorld(this.screenPoint(event));
  },

  /** Finger travel in world space so orders still feel right while zoomed. */
  orderDragMin() {
    const min = this.uiMetrics().dragMin;
    if (!this.telescope) return min;
    return min / this.telescopeScale(this.telescope.lane);
  },

  laneDragMin() {
    if (!this.telescope) return CONFIG.laneDragMin;
    return CONFIG.laneDragMin / this.telescopeScale(this.telescope.lane);
  },

  /** Closest friendly troop under the cursor, or null. */
  hitTroop(event) {
    return this.hitTroopAt(this.worldPoint(event));
  },

  hitTroopAt(point) {
    return this.hitSideTroopAt(point, this.player);
  },

  /** Closest living troop under the cursor on either side. */
  hitAnyTroopAt(point) {
    // 3D raycast pick takes priority over ground-plane distance.
    const picked = this.troopByPickedId();
    if (picked) return picked;
    const mine = this.hitSideTroopAt(point, this.player);
    const theirs = this.hitSideTroopAt(point, this.enemy);
    if (!mine) return theirs;
    if (!theirs) return mine;
    return distance(point, mine) <= distance(point, theirs) ? mine : theirs;
  },

  /** Living troop matching the latest 3D raycast id, if any. */
  troopByPickedId() {
    if (this.pickedTroopId == null) return null;
    const sides = [this.player, this.enemy];
    for (let s = 0; s < sides.length; s += 1) {
      const side = sides[s];
      if (!side) continue;
      for (let i = 0; i < side.troops.length; i += 1) {
        const troop = side.troops[i];
        if (troop.id === this.pickedTroopId && troop.hp > 0) return troop;
      }
    }
    return null;
  },

  hitSideTroopAt(point, side) {
    if (!side) return null;
    if (this.pickedTroopId != null) {
      for (let i = 0; i < side.troops.length; i += 1) {
        const troop = side.troops[i];
        if (troop.id === this.pickedTroopId && troop.hp > 0) return troop;
      }
    }
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      if (troop.hp <= 0) continue;
      const reach = troop.bodyRadius() + this.uiMetrics().unitReach;
      const d = distance(point, troop);
      if (d <= reach && d < bestD) {
        bestD = d;
        best = troop;
      }
    }
    return best;
  },

  /** True when the cursor is on this side's next bank button. */
  hitBank(event, side) {
    return this.hitBankAt(this.canvasPoint(event), side);
  },

  hitBankAt(point, side) {
    if (!side || side.banks >= CONFIG.bankCount) {
      return false;
    }
    const box = side.bankButtonRect(side.banks);
    return this.pointInBox(point, box, this.uiMetrics().hitPad);
  },

  hitBuyAt(point) {
    const pad = this.uiMetrics().hitPad;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < BUY_UNITS.length; i += 1) {
      const box = this.buyButtonRect(i);
      if (!this.pointInBox(point, box, pad)) {
        continue;
      }
      const d = distance(point, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
      if (d < bestD) {
        bestD = d;
        best = { index: i, type: BUY_UNITS[i].type };
      }
    }
    return best;
  },

  /** Strategy buttons disabled; always miss. */
  hitStrategyAt() {
    return null;
  },

  /** Current mode for a lane (defaults to bastion). */
  targetingMode(lane) {
    const side = this.player;
    if (!side || !side.targeting) return "bastion";
    return side.targeting[lane] || "bastion";
  },

  /** Next/prev mode in Bastion → Attrition → Terror cycle (unused while disabled). */
  nextTargetingMode(lane, dir) {
    const cur = this.targetingMode(lane);
    let idx = TARGETING_MODES.indexOf(cur);
    if (idx < 0) idx = 0;
    const n = TARGETING_MODES.length;
    return TARGETING_MODES[(idx + dir + n) % n];
  },

  /** Spawn key currently shown on this buy button. Bases default on. */
  selectedBuyUnit(base) {
    const options = variantOptions(base);
    const pick = this.buySelection && this.buySelection[base];
    if (options.indexOf(pick) >= 0) return pick;
    return base;
  },

  /** Cycle base → yellow (elite) → white (light). dir is -1 left or +1 right. */
  cycleBuyVariant(base, dir) {
    const options = variantOptions(base);
    if (options.length < 2) return false;
    if (!this.buySelection) this.buySelection = {};
    this.buySelection[base] = cycleVariantPick(base, this.selectedBuyUnit(base), dir);
    return true;
  },

  /**
   * One centered row in the open gap under the top lane.
   * Land-cost chips sit under slots that show an alternate.
   */
  buyRowLayout() {
    const ui = this.uiMetrics();
    const needsLandRow = Boolean(
      this.player
      && BUY_UNITS.some((unit) => this.selectedBuyUnit(unit.type) !== unit.type),
    );
    const unlockH = needsLandRow ? Math.round(ui.buyH * 0.28) : 0;
    const gap = unlockH ? 4 * CONFIG.uiScale : 0;
    const h = ui.buyH;
    const strategyH = Math.round(ui.buyH * 0.42);
    const strategyGap = 6 * CONFIG.uiScale;
    const reserveUnlockH = Math.round(ui.buyH * 0.28);
    const reserveUnlockGap = 4 * CONFIG.uiScale;
    const row = BUY_UNITS.length * ui.buyW + (BUY_UNITS.length - 1) * ui.buyGap;
    const x = CONFIG.canvasWidth / 2 - row / 2;
    const pad = 0;
    const minY = CONFIG.playerCapital.y + CONFIG.topLaneHeight / 2 + pad;
    const c = Path.bottomCenter();
    const rIn = Path.bottomRadius(CONFIG.bottomSublaneCount - 1);
    const dx = Math.min(row / 2, rIn - 8);
    const ringY = c.y + Math.sqrt(Math.max(0, rIn * rIn - dx * dx));
    const maxY = ringY - pad - h - reserveUnlockGap - reserveUnlockH - strategyGap - strategyH;
    // Pack the buy / upgrade-readout cluster toward the bottom of the pocket.
    let y = maxY;
    y = Math.max(minY, Math.min(y, maxY));
    return { x, y, h, unlockH, unlockGap: gap, ui, strategyH, strategyGap, row };
  },

  /**
   * Two buy-width slots centered under the buy row (upgrade readouts).
   * Y always assumes the land-cost strip height so the row does not jump
   * when alternate buy chips appear or disappear.
   */
  strategyRowLayout() {
    const buy = this.buyRowLayout();
    const ui = buy.ui;
    const w = ui.buyW;
    const gap = ui.buyGap;
    const unlockH = Math.round(ui.buyH * 0.28);
    const unlockGap = 4 * CONFIG.uiScale;
    const row = 2 * w + gap;
    const x = CONFIG.canvasWidth / 2 - row / 2;
    const y = buy.y + buy.h + unlockGap + unlockH + buy.strategyGap;
    return {
      x,
      y,
      w,
      h: buy.strategyH,
      gap,
      ui,
    };
  },

  strategyButtonRect(lane) {
    const layout = this.strategyRowLayout();
    const ids = Path.laneIds();
    let index = ids.indexOf(lane);
    if (index < 0) index = isArcLane(lane) ? Math.max(0, ids.length - 1) : 0;
    return {
      x: layout.x + index * (layout.w + layout.gap),
      y: layout.y,
      w: layout.w,
      h: layout.h,
      lane,
    };
  },

  /**
   * Full strategy-row box for the centered upgrade HUD
   * (player values | icons | enemy values).
   */
  upgradeReadoutRect() {
    const layout = this.strategyRowLayout();
    return {
      x: layout.x,
      y: layout.y,
      w: layout.w * 2 + layout.gap,
      h: layout.h,
    };
  },

  buyButtonRect(index) {
    const layout = this.buyRowLayout();
    const ui = layout.ui;
    return {
      x: layout.x + index * (ui.buyW + ui.buyGap),
      y: layout.y,
      w: ui.buyW,
      h: layout.h,
    };
  },

  /** Non-clickable land-cost strip under a buy slot showing an alternate. */
  variantLandRect(index) {
    const layout = this.buyRowLayout();
    const ui = layout.ui;
    return {
      x: layout.x + index * (ui.buyW + ui.buyGap),
      y: layout.y + layout.h + layout.unlockGap,
      w: ui.buyW,
      h: layout.unlockH,
    };
  },

  /** Owned town under the cursor, or null. */
  hitCheckpoint(event) {
    return this.hitCheckpointAt(this.worldPoint(event));
  },

  hitCheckpointAt(point) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < this.checkpoints.length; i += 1) {
      const town = this.checkpoints[i];
      const d = distance(point, town);
      if (d <= town.radius() + this.uiMetrics().townReach && d < bestD) {
        bestD = d;
        best = town;
      }
    }
    return best;
  },

  screenPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (CONFIG.canvasWidth / rect.width),
      y: (event.clientY - rect.top) * (CONFIG.canvasHeight / rect.height),
    };
  },

  /** Any troop under a world point, friendly or enemy. */
  hitUnitAt(point) {
    const sides = [this.player, this.enemy];
    let best = null;
    let bestD = Infinity;
    for (let s = 0; s < sides.length; s += 1) {
      const troops = sides[s] ? sides[s].troops : [];
      for (let i = 0; i < troops.length; i += 1) {
        const troop = troops[i];
        if (troop.hp <= 0) continue;
        const reach = troop.bodyRadius() + this.uiMetrics().unitReach;
        const d = distance(point, troop);
        if (d <= reach && d < bestD) {
          bestD = d;
          best = troop;
        }
      }
    }
    return best;
  },

  /**
   * The lane under a world point, and how far it sits from the player keep.
   * Empty field, towns, and keeps return null.
   */
  laneAt(point) {
    const board = Path.activeBoard();
    const left = board.playerCapital;
    const right = board.enemyCapital;
    const ids = Path.laneIds();
    for (let i = 0; i < ids.length; i += 1) {
      const lane = ids[i];
      const def = Path.laneDef(lane);
      if (!def || !def.geometry) continue;
      if (def.geometry.kind === "line") {
        const height = def.geometry.height || CONFIG.topLaneHeight;
        const top = left.y - height / 2;
        const bottom = left.y + height / 2;
        if (point.y >= top && point.y <= bottom && point.x >= left.x && point.x <= right.x) {
          return { lane, along: Path.stationAt(lane, point.x, point.y) };
        }
        continue;
      }
      if (def.geometry.kind === "arc") {
        const c = Path.arcCenter(lane);
        const dx = point.x - c.x;
        const dy = point.y - c.y;
        if (dy < 0) continue;
        const dist = Math.hypot(dx, dy);
        const width = def.geometry.sublaneWidth;
        const outer = Path.arcRadius(lane, 0) + width / 2;
        const inner = Path.arcRadius(lane, def.geometry.sublaneCount - 1) - width / 2;
        if (dist < inner || dist > outer) continue;
        const along = (Path.stationAt(lane, point.x, point.y) / 180) * this.laneLength(lane);
        return { lane, along };
      }
    }
    return null;
  },

  /** Shortest distance from a world point to a lane centerline. */
  laneDistance(lane, point) {
    const pts = Path.centerline(lane);
    let best = Infinity;
    for (let i = 1; i < pts.length; i += 1) {
      const from = pts[i - 1];
      const to = pts[i];
      const d = pointToSegment(point, from.x, from.y, to.x, to.y);
      if (d < best) best = d;
    }
    return best;
  },

  /**
   * Closest lane to a world point (even off the road), for wheel / pinch zoom.
   * Along is measured from the player keep, matching openTelescopeAt.
   */
  nearestLaneAt(point) {
    const ids = Path.laneIds();
    let best = ids[0] || "top";
    let bestD = Infinity;
    for (let i = 0; i < ids.length; i += 1) {
      const d = this.laneDistance(ids[i], point);
      if (d < bestD) {
        bestD = d;
        best = ids[i];
      }
    }
    if (isArcLane(best)) {
      const along = (Path.stationAt(best, point.x, point.y) / 180) * this.laneLength(best);
      return { lane: best, along };
    }
    return { lane: best, along: Path.stationAt(best, point.x, point.y) };
  },

  /** Undo the zoom camera. Southpaw is undone first so the point is in view space. */
  telescopeWorld(screen) {
    let x = screen.x;
    const y = screen.y;
    if (this.southpaw) x = CONFIG.canvasWidth - x;
    const cam = this.telescopeCamera();
    const dx = x - CONFIG.canvasWidth / 2;
    const dy = y - CONFIG.canvasHeight / 2;
    const cos = Math.cos(cam.angle);
    const sin = Math.sin(cam.angle);
    return {
      x: (dx * cos - dy * sin) / cam.scale + cam.x,
      y: (dx * sin + dy * cos) / cam.scale + cam.y,
    };
  },

  /**
   * Project a world point into telescope view space (before southpaw).
   * Inverse of telescopeWorld without the southpaw mirror.
   */
  telescopeView(world) {
    const cam = this.telescopeCamera();
    const wx = world.x - cam.x;
    const wy = world.y - cam.y;
    const cos = Math.cos(cam.angle);
    const sin = Math.sin(cam.angle);
    return {
      x: CONFIG.canvasWidth / 2 + cam.scale * (wx * cos + wy * sin),
      y: CONFIG.canvasHeight / 2 + cam.scale * (-wx * sin + wy * cos),
    };
  },

  laneLength(lane) {
    return Path.length(Path.centerline(lane));
  },

  /**
   * Top lane fills most of the view, leaving field around it. Bottom uses
   * that same zoom, adjusted so its row gap matches the top lane.
   */
  telescopeScale(lane) {
    const topScale = (CONFIG.canvasHeight * 0.62) / CONFIG.topLaneHeight;
    if (lane !== "bottom") return topScale;
    const topPitch = (CONFIG.topSublaneSpread * 2) / (CONFIG.topSublaneCount - 1);
    const bottomPitch = (CONFIG.bottomSublaneSpread * 2) / (CONFIG.bottomSublaneCount - 1);
    return topScale * (topPitch / bottomPitch);
  },

  telescopeHalf(lane) {
    return (CONFIG.canvasWidth / this.telescopeScale(lane)) / 2;
  },

  clampAlong(lane, along) {
    const len = this.laneLength(lane);
    // Swing far enough toward each keep that the capital stays in view.
    const margin = this.telescopeHalf(lane) * 0.18;
    const half = Math.min(len / 2, margin);
    return Math.max(half, Math.min(len - half, along));
  },

  /**
   * The bottom lane is drawn as a true half-circle. Follow that circle
   * so the view rotates continuously. A polyline tangent holds still on
   * each chord and then jumps.
   */
  bottomCamera(t) {
    const sub = Math.floor(Path.sublaneCount("bottom") / 2);
    const c = Path.bottomCenter();
    const radius = Path.bottomRadius(sub);
    const theta = Math.PI * (1 - t);
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);
    return {
      x: c.x + radius * cos,
      y: c.y + radius * sin,
      angle: Math.atan2(-cos, sin),
    };
  },

  telescopeCamera() {
    const lane = this.telescope.lane;
    const len = this.laneLength(lane);
    const t = len <= 0 ? 0 : this.telescope.along / len;
    if (lane === "bottom") {
      const at = this.bottomCamera(t);
      const scale = this.telescopeScale(lane);
      // Shift the aim point toward the top of the screen so the arc
      // sits a little lower, with room above for the scoreboard.
      const lift = (CONFIG.canvasHeight * 0.15) / scale;
      const upX = Math.sin(at.angle);
      const upY = -Math.cos(at.angle);
      return {
        x: at.x + upX * lift,
        y: at.y + upY * lift,
        angle: at.angle,
        scale,
      };
    }
    const pts = Path.centerline(lane);
    const at = Path.pointAt(pts, t);
    const tan = Path.tangentAt(pts, t);
    return {
      x: at.x,
      y: at.y,
      angle: Math.atan2(tan.y, tan.x),
      scale: this.telescopeScale(lane),
    };
  },

  openTelescopeAt(lane, along) {
    if (!this.player || this.winner || this.status !== "playing") return;
    this.drag = null;
    this.buyDrag = null;
    this.lanePress = null;
    this.enemyPress = null;
    this.telescopeDrag = null;
    this.telescopeSlide = 0;
    this.telescope = { lane, along: this.clampAlong(lane, along) };
    if (this.onTelescopeChange) this.onTelescopeChange();
  },

  closeTelescope() {
    if (!this.telescope) return;
    this.telescope = null;
    this.telescopeDrag = null;
    this.telescopeSlide = 0;
    if (this.onTelescopeChange) this.onTelescopeChange();
  },

  /** Recent finger motion, so a release can keep sliding. */
  noteTelescopeSample() {
    const drag = this.telescopeDrag;
    if (!drag || !this.telescope) return;
    const now = performance.now();
    drag.samples.push({ t: now, along: this.telescope.along });
    const cutoff = now - 90;
    while (drag.samples.length > 2 && drag.samples[0].t < cutoff) drag.samples.shift();
  },

  /** Horizontal drag walks the lane. A vertical drag jumps to the other lane. */
  moveTelescope(point) {
    const drag = this.telescopeDrag;
    if (!drag || !this.telescope) return;
    const dx = point.x - drag.x;
    const dy = point.y - drag.y;
    const min = 36;
    if (!drag.switched && Math.abs(dy) >= min && Math.abs(dy) > Math.abs(dx)) {
      drag.switched = true;
      this.telescopeSlide = 0;
      const from = this.telescope.lane;
      const len = this.laneLength(from);
      const t = len <= 0 ? 0 : this.telescope.along / len;
      const next = from === "top" ? "bottom" : "top";
      this.telescope.lane = next;
      this.telescope.along = this.clampAlong(next, t * this.laneLength(next));
      drag.samples = [];
      return;
    }
    if (drag.switched) return;
    const scale = this.telescopeScale(this.telescope.lane);
    this.telescope.along = this.clampAlong(this.telescope.lane, drag.along - dx / scale);
    this.noteTelescopeSample();
  },

  /**
   * Let go and the view keeps the last flick, then friction slows it.
   * A lane switch does not coast.
   */
  releaseTelescope() {
    const drag = this.telescopeDrag;
    this.telescopeDrag = null;
    if (!drag || drag.switched || !this.telescope) {
      this.telescopeSlide = 0;
      return;
    }
    const samples = drag.samples;
    if (samples.length < 2) {
      this.telescopeSlide = 0;
      return;
    }
    const a = samples[0];
    const b = samples[samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    this.telescopeSlide = dt > 0 ? (b.along - a.along) / dt : 0;
  },

  /** Coast along the lane until friction, the lane end, or a new touch stops it. */
  stepTelescope() {
    if (!this.telescope) return;
    const now = performance.now();
    const prev = this.telescopeStepAt || now;
    this.telescopeStepAt = now;
    if (this.telescopeDrag) return;
    let v = this.telescopeSlide || 0;
    if (v === 0) return;
    const dt = Math.min(0.05, (now - prev) / 1000);
    const lane = this.telescope.lane;
    const next = this.clampAlong(lane, this.telescope.along + v * dt);
    if (next === this.telescope.along) {
      this.telescopeSlide = 0;
      return;
    }
    this.telescope.along = next;
    v *= Math.exp(-2.4 * dt);
    this.telescopeSlide = Math.abs(v) < 18 ? 0 : v;
  },

  inspectedTroop() {
    if (this.inspectedId == null || !this.player) {
      this.inspectedLineIds = null;
      return null;
    }
    const sides = [this.player, this.enemy];
    let troop = null;
    for (let s = 0; s < sides.length; s += 1) {
      if (!sides[s]) continue;
      const found = sides[s].troops.find((unit) => unit.id === this.inspectedId);
      if (found && found.hp > 0) {
        troop = found;
        break;
      }
    }
    if (!troop) {
      this.inspectedId = null;
      this.inspectedSolo = false;
      this.inspectedLineIds = null;
      return null;
    }
    // Selection is whoever received the order. Do not grow it as the line changes.
    this.pruneInspectedLine(troop);
    return troop;
  },

  /**
   * Remember the units that received this selection. A later arrival that
   * walks into the line was not given the order, so it stays unmarked.
   */
  captureInspectedLine(troop) {
    if (!troop) return;
    const allies = troop.side.troops;
    let group = this.inspectedSolo ? [troop] : lineGroup(troop, allies);
    // Melee units stay in the line for bonuses, but are never group-selected.
    if (!this.inspectedSolo) {
      group = group.filter((unit) => unit === troop || !this.isTroopInMelee(unit));
    }
    const ids = {};
    for (let i = 0; i < group.length; i += 1) ids[group[i].id] = true;
    this.inspectedLineIds = ids;
  },

  /** Drop dead units. Units that join the line afterward are not added. */
  pruneInspectedLine(troop) {
    if (!this.inspectedLineIds) {
      this.captureInspectedLine(troop);
      return;
    }
    const ids = this.inspectedLineIds;
    const sides = [this.player, this.enemy];
    const live = {};
    for (let s = 0; s < sides.length; s += 1) {
      const troops = sides[s] && sides[s].troops;
      if (!troops) continue;
      for (let i = 0; i < troops.length; i += 1) {
        const unit = troops[i];
        if (ids[unit.id] && unit.hp > 0) live[unit.id] = true;
      }
    }
    this.inspectedLineIds = live;
  },

  announceOrder(troop, action, dir) {
    if (troop) {
      this.inspectedId = troop.id;
      if (this.isTroopInMelee(troop)) this.inspectedSolo = true;
      this.captureInspectedLine(troop);
    }
    // Broken units ignore orders; keep the steady "Broken" readout.
    if (troop && troop.broken) {
      this.orderCallout = null;
      return;
    }
    if (troop) {
      const foes = troop.side && troop.side.id === "player"
        ? (this.enemy && this.enemy.troops)
        : (this.player && this.player.troops);
      troop.inMelee = bodyInMelee(troop, foes || []);
    }
    const shown = this.switchAnnouncement(troop, action, dir) || orderAnnouncement(troop, action);
    if (!shown) return;
    this.orderCallout = {
      text: shown.text,
      color: shown.color,
      until: performance.now() + 900,
    };
  },

  /**
   * Swipe into an overlapping matching neighbor → Reform only.
   * Clear swipe on a staggered line → Reform (then switch). Squared clear → Switch.
   */
  switchAnnouncement(troop, action, dir) {
    if (action !== "switch" && action !== "shift" && action !== "lane") return null;
    if (!troop || this.inspectedSolo || !troop.side) return null;
    const allies = troop.side.troops;
    if (dir === 1 || dir === -1) {
      const mate = lineMateOnRow(troop, troop.sublane + dir, allies);
      if (mate) return { text: "Reform", color: CONFIG.colors.reform };
    }
    const group = reformSeekGroup(troop, allies);
    if (group.length < 2 || lineIsPerfect(group)) return null;
    return { text: "Reform", color: CONFIG.colors.reform };
  },

  /**
   * Tooltip / callout word for an across-swipe in ±1 sublane direction.
   * Solo units always Switch; lines may Reform into a matching mate or stagger.
   */
  switchSwipeLabel(troop, dir, solo) {
    if (dir !== 1 && dir !== -1) return "Switch";
    if (solo || !troop || !troop.side) return "Switch";
    const allies = troop.side.troops;
    if (lineMateOnRow(troop, troop.sublane + dir, allies)) return "Reform";
    const group = reformSeekGroup(troop, allies);
    if (group.length >= 2 && !lineIsPerfect(group)) return "Reform";
    return "Switch";
  },

  /**
   * Whether a +across swipe (screen "down" label) steps sublane +1 or −1.
   * Returns the sublane dir for that visual side, or 0 if neither neighbor exists.
   */
  acrossSwipeDir(troop, towardAcrossPositive) {
    if (!troop || !troop.side) return 0;
    const count = Path.sublaneCount(troop.lane);
    const tan = Path.tangentAt(
      Path.waypoints(troop.side.id, troop.lane, troop.sublane),
      troop.progress || 0,
    );
    const across = { x: -tan.y, y: tan.x };
    const here = Path.pointAt(
      Path.waypoints(troop.side.id, troop.lane, troop.sublane),
      troop.progress || 0,
    );
    let best = 0;
    let bestDot = -Infinity;
    for (const dir of [-1, 1]) {
      const row = troop.sublane + dir;
      if (row < 0 || row >= count) continue;
      const next = Path.pointAt(
        Path.waypoints(troop.side.id, troop.lane, row),
        troop.progress || 0,
      );
      const dot = (next.x - here.x) * across.x + (next.y - here.y) * across.y;
      const want = towardAcrossPositive ? dot > 0 : dot < 0;
      if (want && Math.abs(dot) > bestDot) {
        bestDot = Math.abs(dot);
        best = dir;
      }
    }
    return best;
  },

  /** True when this troop is locked in body contact with a melee foe. */
  isTroopInMelee(troop) {
    if (!troop || !this.player || !this.enemy) return false;
    const foes = troop.side && troop.side.id === "player"
      ? this.enemy.troops
      : this.player.troops;
    return inMeleeContact(troop, foes || []);
  },
};

function unitTypeLabel(type) {
  if (UNIT_LABELS[type]) return UNIT_LABELS[type];
  for (let i = 0; i < BUY_UNITS.length; i += 1) {
    if (BUY_UNITS[i].type === type) return BUY_UNITS[i].label;
  }
  return type;
}

function troopStation(troop) {
  return Path.stationAt(troop.lane, troop.x, troop.y);
}

function lineSlack(troop) {
  const radius = troop.lane === "bottom" ? Path.bottomRadius(troop.sublane) : 0;
  return Path.stationSlack(troop.lane, "line", radius);
}

function perfectSlack(troop) {
  return Path.stationSlack(troop.lane, "parallel");
}

/** 1 at Perfect Line, 0 at the In Line edge, linear between. */
function lineOverlapRatio(a, b) {
  const gap = Math.abs(troopStation(a) - troopStation(b));
  const perfect = perfectSlack(a);
  const inLine = lineSlack(a);
  if (gap <= perfect) return 1;
  if (gap >= inLine || !(inLine > perfect)) return 0;
  return 1 - (gap - perfect) / (inLine - perfect);
}

/** Average Perfect→In Line quality vs adjacent-row members of this line. */
function lineNeighborQuality(troop, line) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < line.length; i += 1) {
    const mate = line[i];
    if (mate === troop || Math.abs(troop.sublane - mate.sublane) !== 1) continue;
    sum += lineOverlapRatio(troop, mate);
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

function lineIsPerfect(group) {
  if (!group || group.length < 2) return true;
  const slack = Path.stationSlack(group[0].lane, "parallel");
  const player = group[0].side && group[0].side.id === "player";
  let front = group[0];
  for (let i = 1; i < group.length; i += 1) {
    const ahead = player
      ? troopStation(group[i]) > troopStation(front)
      : troopStation(group[i]) < troopStation(front);
    if (ahead) front = group[i];
  }
  const at = troopStation(front);
  for (let i = 0; i < group.length; i += 1) {
    if (Math.abs(troopStation(group[i]) - at) > slack) return false;
  }
  return true;
}

function inLineWith(member, ally) {
  if (ally.hp <= 0 || ally.lane !== member.lane || ally.type !== member.type) return false;
  if (Math.abs(member.sublane - ally.sublane) !== 1) return false;
  return Math.abs(troopStation(member) - troopStation(ally)) <= lineSlack(member);
}

/** Same-type In-Line friendly on this row, if any. */
function lineMateOnRow(troop, sublane, allies) {
  for (let i = 0; i < allies.length; i += 1) {
    const ally = allies[i];
    if (ally === troop || ally.hp <= 0 || ally.broken) continue;
    if (ally.lane !== troop.lane || ally.sublane !== sublane) continue;
    if (ally.type !== troop.type) continue;
    if (Math.abs(troopStation(troop) - troopStation(ally)) > lineSlack(troop)) continue;
    return ally;
  }
  return null;
}

/** Same adjacent-row grouping the sim uses for line damage. */
function lineGroup(troop, allies) {
  const cap = Path.sublaneCount(troop.lane);
  const group = [troop];
  const seen = {};
  const usedRow = {};
  seen[troop.id] = true;
  usedRow[troop.sublane] = true;
  let added = true;
  while (added && group.length < cap) {
    added = false;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < group.length; i += 1) {
      const member = group[i];
      for (let j = 0; j < allies.length; j += 1) {
        const ally = allies[j];
        if (seen[ally.id] || ally.hp <= 0 || usedRow[ally.sublane]) continue;
        if (!inLineWith(member, ally)) continue;
        const dist = Math.abs(troopStation(ally) - troopStation(troop));
        if (dist < bestDist) {
          bestDist = dist;
          best = ally;
        }
      }
    }
    if (best) {
      seen[best.id] = true;
      usedRow[best.sublane] = true;
      group.push(best);
      added = true;
    }
  }
  return group;
}

/**
 * Reform's initial recruit: adjacent same-type chain within In Line.
 * Matches server reformSeekGroup.
 */
function reformSeekGroup(troop, allies) {
  const cap = Path.sublaneCount(troop.lane);
  const group = [troop];
  const seen = {};
  const usedRow = {};
  seen[troop.id] = true;
  usedRow[troop.sublane] = true;
  let added = true;
  while (added && group.length < cap) {
    added = false;
    for (let i = 0; i < group.length && group.length < cap; i += 1) {
      const member = group[i];
      for (let j = 0; j < allies.length; j += 1) {
        const ally = allies[j];
        if (seen[ally.id] || ally.hp <= 0 || usedRow[ally.sublane]) continue;
        if (ally.broken || !inLineWith(member, ally)) continue;
        seen[ally.id] = true;
        usedRow[ally.sublane] = true;
        group.push(ally);
        added = true;
        if (group.length >= cap) break;
      }
    }
  }
  return group;
}

function lineSize(troop, allies) {
  return lineGroup(troop, allies).length;
}

function troopKindStats(troop) {
  return unitStats(troop.variant || troop.type);
}

function flankSlack(troop) {
  const radius = troop.lane === "bottom" ? Path.bottomRadius(troop.sublane) : 0;
  return Path.stationSlack(troop.lane, "flank", radius);
}

function isFlanking(troop, target) {
  if (troop.order !== "charge" || target.hp <= 0) return false;
  if (!target.lane || target.lane !== troop.lane || target.sublane === troop.sublane) return false;
  return Math.abs(troopStation(troop) - troopStation(target)) <= flankSlack(troop);
}

function hasChargeSpeed(troop) {
  const stats = troopKindStats(troop);
  if (troop.order !== "charge" && troop.order !== "retreat") return false;
  if (!stats.chargeSpeed || stats.chargeSpeed === 1) return false;
  return true;
}

/** Other living Hussar whose bodies sit in this unit's melee reach. */
function hussarPackMates(troop, allies) {
  const radius = typeof troop.bodyRadius === "function"
    ? troop.bodyRadius()
    : (troop.radius || troopKindStats(troop).radius);
  const reach = radius + (CONFIG.meleeSlack || 0);
  let n = 0;
  for (let i = 0; i < allies.length; i += 1) {
    const ally = allies[i];
    if (!ally || ally === troop || ally.hp <= 0) continue;
    if (ally.variant !== "hussar") continue;
    if (ally.lane !== troop.lane) continue;
    const allyRadius = typeof ally.bodyRadius === "function"
      ? ally.bodyRadius()
      : (ally.radius || troopKindStats(ally).radius);
    if (distance(troop, ally) <= reach + allyRadius) n += 1;
  }
  return n;
}

/** Body contact, same test the sim uses for melee order lock. */
function bodyInMelee(troop, enemies) {
  const stats = troopKindStats(troop);
  if (!stats.fightsMelee || troop.hp <= 0) return false;
  const radius = troop.radius || stats.radius;
  const reach = radius + (CONFIG.meleeSlack || 0);
  for (let i = 0; i < enemies.length; i += 1) {
    const foe = enemies[i];
    if (!foe || foe.hp <= 0 || foe.lane !== troop.lane) continue;
    const foeStats = troopKindStats(foe);
    if (!foeStats.fightsMelee) continue;
    const foeRadius = foe.radius || foeStats.radius;
    if (distance(troop, foe) <= reach + foeRadius) return true;
  }
  return false;
}

function inMeleeContact(troop, enemies) {
  const stats = troopKindStats(troop);
  if (!stats.fightsMelee || troop.hp <= 0) return false;
  const slack = Path.stationSlack(troop.lane, "melee");
  const myStation = Path.stationAt(troop.lane, troop.x, troop.y);
  for (let i = 0; i < enemies.length; i += 1) {
    const foe = enemies[i];
    if (foe === troop || foe.hp <= 0 || foe.lane !== troop.lane) continue;
    if (!troopKindStats(foe).fightsMelee) continue;
    if (Math.abs(troop.sublane - foe.sublane) > 1) continue;
    const foeStation = Path.stationAt(foe.lane, foe.x, foe.y);
    if (Math.abs(myStation - foeStation) <= slack) return true;
  }
  return false;
}

function inCapitalRange(troop) {
  const capital = troop.side && troop.side.capital;
  if (!capital) return false;
  return distance(troop, capital) <= CONFIG.capitalCannonRange;
}

/**
 * "color" while a color guard is restoring this unit, "officer" for a
 * plain officer, or null when nobody nearby is restoring.
 */
function underOfficerRestore(troop, allies) {
  let found = null;
  for (let i = 0; i < allies.length; i += 1) {
    const ally = allies[i];
    if (ally === troop || ally.hp <= 0) continue;
    const stats = troopKindStats(ally);
    if (!(stats.restoreRate > 0) || !(stats.restoreRange > 0)) continue;
    if (distance(troop, ally) > stats.restoreRange) continue;
    if (ally.variant === "colorGuard") return "color";
    found = "officer";
  }
  return found;
}

function multText(n) {
  const rounded = Math.round(n * 100) / 100;
  return `×${rounded}`;
}

/** Bonuses and live statuses that change this unit's damage, speed, armor, or fatigue. */
function activeBonuses(board, troop, allies) {
  const stats = troopKindStats(troop);
  const side = troop.side;
  const foes = side && side.id === "player" ? board.enemy : board.player;
  const enemies = foes ? foes.troops : [];
  const labels = [];

  const line = lineGroup(troop, allies);
  const mates = line.length - 1;
  if (troop.type === "troop" && CONFIG.troopLineBonus > 0 && mates > 0) {
    const pct = mates * CONFIG.troopLineBonus * lineNeighborQuality(troop, line);
    labels.push(`Line +${Math.round(pct * 100)}%`);
  }

  if (troop.variant === "hussar" && CONFIG.cavalryPackBonus > 0) {
    const packMates = hussarPackMates(troop, allies);
    if (packMates > 0) {
      labels.push(`Pack +${Math.round(packMates * CONFIG.cavalryPackBonus * 100)}%`);
    }
  }

  if (troop.order === "charge" && stats.chargeMultiplier && stats.chargeMultiplier !== 1) {
    labels.push(`Charge ${multText(stats.chargeMultiplier)}`);
  }
  // if (hasChargeSpeed(troop)) {
  //   const label = troop.order === "retreat" ? "Retreat speed" : "Charge speed";
  //   labels.push(`${label} ${multText(troopKindStats(troop).chargeSpeed)}`);
  // }

  let flanking = false;
  for (let i = 0; i < enemies.length; i += 1) {
    const foe = enemies[i];
    if (isFlanking(troop, foe)) {
      flanking = true;
      break;
    }
  }
  if (flanking && stats.flankMultiplier && stats.flankMultiplier !== 1) {
    labels.push(`Flank ${multText(stats.flankMultiplier)}`);
  }

  // Standing in woods, a peak, a hill, or your own fort footprint.
  const terrainCover = terrainCoverParts(troop, null, board.mapId);
  for (let i = 0; i < terrainCover.length; i += 1) {
    labels.push(`Cover +${Math.round(terrainCover[i] * 100)}%`);
  }

  // if (side) {
  //   if (side.speedMultiplier && side.speedMultiplier !== 1) {
  //     labels.push(`Upgrade speed ${multText(side.speedMultiplier)}`);
  //   }
  //   const armorRanks = side.upgrades ? side.upgrades.armor : 0;
  //   if (armorRanks > 0) {
  //     const armor = Math.min(CONFIG.armorCap, CONFIG.armorPerUpgrade * armorRanks);
  //     labels.push(`Armor +${Math.round(armor * 100)}%`);
  //   }
  //   const dmgRanks = side.upgrades ? side.upgrades.damage : 0;
  //   if (dmgRanks > 0) {
  //     labels.push(`Upgrade dmg ${multText(1 + CONFIG.damageUpgradeAmount * dmgRanks)}`);
  //   }
  // }

  // if (troop.order === "reform") {
  //   labels.push(`Reform speed ${multText(CONFIG.reformSpeedFactor)}`);
  // } else if (troop.order === "fallback" && !troop.broken) {
  //   labels.push(`Fallback speed ${multText(CONFIG.reformSpeedFactor)}`);
  // }

  // if (troop.lane === "bottom") {
  //   const outer = Path.bottomRadius(0);
  //   if (outer > 0) {
  //     const ring = Path.bottomRadius(troop.sublane) / outer;
  //     if (Math.abs(ring - 1) > 0.01) {
  //       labels.push(`Ring speed ${multText(ring)}`);
  //     }
  //   }
  // }

  const restore = underOfficerRestore(troop, allies);
  const maxHp = troop.maxHP ? troop.maxHP() : troopKindStats(troop).hp;
  const hpPct = maxHp > 0 ? Math.max(0, Math.min(1, troop.hp / maxHp)) : 1;
  if (restore === "color") {
    labels.push("Color restore");
  } else if (hpPct < 1) {
    const loss = Math.round((1 - hpPct) * CONFIG.missingHealthDamageRatio * 100);
    if (loss > 0) labels.push(`Wounded −${loss}% dmg`);
  }
  if (restore === "officer") {
    labels.push("Officer restore");
  }
  if (restore !== "color" && restore !== "officer" && inCapitalRange(troop)) {
    labels.push("Recovering");
  } else if (restore !== "color" && restore !== "officer" && troop.order === "halt") {
    labels.push("Recovering");
  }

  // if (stats.speed && stats.speed !== UNIT_STATS.troop.speed) {
  //   labels.push(`Walk ${multText(stats.speed / UNIT_STATS.troop.speed)}`);
  // }

  return labels.join("   ");
}

function orderStatus(order, broken) {
  if (broken) return { text: "Broken", color: "#000000" };
  if (order === "halt") return { text: "Halt", color: CONFIG.colors.halt };
  if (order === "reform") return { text: "Reform", color: CONFIG.colors.reform };
  if (order === "charge") return { text: "Charge", color: CONFIG.colors.charge };
  if (order === "fallback") return { text: "Fallback", color: CONFIG.colors.fallback };
  if (order === "retreat") return { text: "Retreat", color: CONFIG.colors.retreat };
  return { text: "Advance", color: CONFIG.colors.text };
}

function orderAnnouncement(troop, action) {
  if (action === "reform") {
    return { text: "Reform", color: CONFIG.colors.reform };
  }
  if (action === "restore") {
    let want = troop && troop.priorOrder;
    if (want === "reform") want = null;
    if (want !== "halt" && want !== "charge" && want !== "fallback"
        && want !== "retreat" && want !== null) {
      want = null;
    }
    return orderStatus(want, false);
  }
  if (action === "speedUp" || action === "speedDown") {
    const ladder = ["retreat", "fallback", "halt", null, "charge"];
    let idx = 3;
    if (troop.order === "retreat") idx = 0;
    else if (troop.order === "fallback") idx = 1;
    else if (troop.order === "halt") idx = 2;
    else if (troop.order === "charge") idx = 4;
    const next = action === "speedUp"
      ? Math.min(ladder.length - 1, idx + 1)
      : Math.max(0, idx - 1);
    const nextOrder = ladder[next];
    if (action === "speedDown" && troop && troop.inMelee
      && (nextOrder === "fallback" || nextOrder === "retreat")) {
      return orderStatus("retreat", false);
    }
    return orderStatus(nextOrder, false);
  }
  if (action === "cycle") {
    if (troop && troop.order === "halt") return { text: "Advance", color: CONFIG.colors.text };
    return { text: "Halt", color: CONFIG.colors.halt };
  }
  if (action === "charge" || action === "forward") {
    return { text: "Charge", color: CONFIG.colors.charge };
  }
  if (action === "fallback" || action === "back") {
    if (troop && troop.inMelee) return { text: "Retreat", color: CONFIG.colors.retreat };
    return { text: "Fallback", color: CONFIG.colors.fallback };
  }
  if (action === "switch" || action === "shift") return { text: "Switch", color: CONFIG.colors.laneHover };
  if (action === "lane") return { text: "Switch", color: CONFIG.colors.laneHover };
  return null;
}

const SOUTHPAW_KEY = "motl-southpaw";
const TERRAIN_LABELS_KEY = "motl-terrain-labels";

export function readSouthpaw() {
  try {
    return localStorage.getItem(SOUTHPAW_KEY) === "1";
  } catch (err) {
    return false;
  }
}

export function writeSouthpaw(on) {
  try {
    localStorage.setItem(SOUTHPAW_KEY, on ? "1" : "0");
  } catch (err) {
    // Storage can be blocked; the in-memory flag still applies this session.
  }
}

/** Terrain emoji labels; on by default when unset. */
export function readTerrainLabels() {
  try {
    const stored = localStorage.getItem(TERRAIN_LABELS_KEY);
    if (stored == null) return true;
    return stored === "1";
  } catch (err) {
    return true;
  }
}

export function writeTerrainLabels(on) {
  try {
    localStorage.setItem(TERRAIN_LABELS_KEY, on ? "1" : "0");
  } catch (err) {
    // Storage can be blocked; the in-memory flag still applies this session.
  }
}

/** True when terrain emojis should draw (settings toggle or training tutorial). */
export function showTerrainLabels(board) {
  return Boolean(board && (board.terrainLabels || board.trainingMode));
}

let troopProto = troopStateMethods;
let townProto = townStateMethods;
let sideProto = sideStateMethods;

/** Canvas drawing mixes these in so troops keep a draw method. */
export function useDrawPrototypes(next) {
  if (next.troop) troopProto = next.troop;
  if (next.town) townProto = next.town;
  if (next.side) sideProto = next.side;
}

function writeTroop(troop, data, side, mx) {
  troop.id = data.id;
  troop.lane = data.lane;
  troop.sublane = data.sublane;
  troop.type = data.type;
  troop.variant = data.variant || null;
  troop.alternate = Boolean(data.alternate);
  troop.hp = data.hp;
  troop.maxHp = data.maxHp;
  troop.fatigue = data.fatigue;
  troop.maxFatigue = data.maxFatigue;
  troop.broken = Boolean(data.broken);
  troop.priorOrder = data.priorOrder === undefined ? null : data.priorOrder;
  troop.radius = data.radius;
  noteMotion(troop, mx(data.x), data.y, data.lane, data.sublane);
  troop.order = data.order;
  troop.squared = Boolean(data.squared);
  troop.flash = data.flash;
  troop.progress = data.progress;
  troop.side = side;
  return troop;
}

function noteMotion(troop, x, y, lane, sublane) {
  const next = { x, y, lane, sublane };
  const prev = troop.motionNext;
  const dx = prev ? x - prev.x : 0;
  const dy = prev ? y - prev.y : 0;
  const far = prev && (dx * dx + dy * dy > SNAP_PX * SNAP_PX);
  const rowChanged = prev && (prev.lane !== lane || prev.sublane !== sublane);
  if (!prev || far || rowChanged) {
    troop.motionPrev = null;
    troop.x = x;
    troop.y = y;
  } else {
    troop.motionPrev = prev;
  }
  troop.motionNext = next;
}

function notePointMotion(entity, x, y, snapPx = SNAP_PX) {
  const next = { x, y };
  const prev = entity.motionNext;
  const dx = prev ? x - prev.x : 0;
  const dy = prev ? y - prev.y : 0;
  const far = prev && (dx * dx + dy * dy > snapPx * snapPx);
  if (!prev || far) {
    entity.motionPrev = null;
    entity.x = x;
    entity.y = y;
  } else {
    entity.motionPrev = prev;
  }
  entity.motionNext = next;
}

/** Rise/fade hit numbers on the client so they are not locked to snapshot rate. */
function stepSplats(board, dt) {
  const list = board.splats;
  if (!list || !list.length || !(dt > 0)) return;
  let write = 0;
  for (let i = 0; i < list.length; i += 1) {
    const splat = list[i];
    splat.age += dt;
    if (splat.age >= CONFIG.splatLife) continue;
    splat.y -= CONFIG.splatRise * dt;
    list[write] = splat;
    write += 1;
  }
  list.length = write;
}

/** Age muzzle smoke for both 2D and 3D clients. */
function stepSmokePuffs(board, dt) {
  const puffs = board.smokePuffs;
  if (!puffs || !puffs.length || !(dt > 0)) return;
  let write = 0;
  for (let i = 0; i < puffs.length; i += 1) {
    const puff = puffs[i];
    puff.age += dt;
    if (puff.age >= puff.life) continue;
    puff.x += puff.vx * dt;
    puff.y += puff.vy * dt;
    puff.vx *= Math.max(0, 1 - 2.4 * dt);
    puff.vy *= Math.max(0, 1 - 2.4 * dt);
    puffs[write] = puff;
    write += 1;
  }
  puffs.length = write;
}

/** Glide troops and shells between the last two authoritative samples. */
export function presentTroopMotion(board, now = performance.now()) {
  if (!board) return;
  const prevAt = board._fxAt;
  board._fxAt = now;
  const fxDt = prevAt != null
    ? Math.min(0.05, Math.max(0, (now - prevAt) / 1000))
    : 0;
  stepSplats(board, fxDt);
  stepSmokePuffs(board, fxDt);
  const alpha = lerpAlpha(now, board.motionAt || now, board.motionGapMs || 0);
  const sides = [board.player, board.enemy];
  for (let s = 0; s < sides.length; s += 1) {
    const side = sides[s];
    if (!side || !side.troops) continue;
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      if (!troop.motionNext) continue;
      const point = lerpTroop(troop.motionPrev, troop.motionNext, alpha, SNAP_PX);
      troop.x = point.x;
      troop.y = point.y;
    }
  }
  const shots = board.projectiles || [];
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    if (!shot || !shot.motionNext) continue;
    const point = lerpPoint(shot.motionPrev, shot.motionNext, alpha, SHOT_SNAP_PX);
    shot.x = point.x;
    shot.y = point.y;
    noteShotTrail(shot);
  }
}

/** Keep a short recent-path ribbon for projectile trails (display only). */
function noteShotTrail(shot) {
  if (!shot.trail) shot.trail = [];
  const trail = shot.trail;
  const last = trail.length ? trail[trail.length - 1] : null;
  if (last) {
    const dx = shot.x - last.x;
    const dy = shot.y - last.y;
    if (dx * dx + dy * dy < 2.25) return;
  }
  trail.push({ x: shot.x, y: shot.y });
  // Cap by point count and total length so the streak stays short.
  const maxPts = 7;
  const maxLen = 22;
  while (trail.length > maxPts) trail.shift();
  let len = 0;
  for (let i = trail.length - 1; i > 0; i -= 1) {
    const a = trail[i];
    const b = trail[i - 1];
    len += Math.hypot(a.x - b.x, a.y - b.y);
    if (len > maxLen) {
      trail.splice(0, i);
      break;
    }
  }
}

/** Client-only muzzle smoke when a shell first appears in a snapshot. */
function spawnGunSmoke(board, x, y, shotSize, color) {
  if (!board.smokePuffs) board.smokePuffs = [];
  const cannon = color === UNIT_STATS.cannon.projectileColor;
  const count = cannon ? 5 : 3;
  const base = Math.max(4, shotSize || UNIT_STATS.troop.projectileSize) * (cannon ? 1.7 : 1);
  for (let i = 0; i < count; i += 1) {
    const ang = Math.random() * Math.PI * 2;
    const spit = 2 + Math.random() * base * 0.6;
    board.smokePuffs.push({
      x: x + Math.cos(ang) * spit * 0.35,
      y: y + Math.sin(ang) * spit * 0.35,
      vx: Math.cos(ang) * (8 + Math.random() * 18),
      vy: Math.sin(ang) * (8 + Math.random() * 18) - 12,
      r0: base * (0.35 + Math.random() * 0.25),
      r1: base * (1.4 + Math.random() * 1.1),
      age: 0,
      life: 0.28 + Math.random() * 0.22,
    });
  }
}

/**
 * Snapshot only announces new hit numbers (by id). Rise/fade runs locally
 * every frame in presentTroopMotion so they are not locked to STATE_MS.
 */
function syncSplats(board, splatSnap, mx, prevElapsed, elapsed) {
  if (!board.splats) board.splats = [];
  if (!board._splatSeen) board._splatSeen = new Set();
  // New match (sim clock restarted): drop leftover client FX.
  if (
    prevElapsed != null
    && Number.isFinite(elapsed)
    && elapsed + 0.1 < prevElapsed
  ) {
    board.splats.length = 0;
    board._splatSeen.clear();
  }
  for (let i = 0; i < splatSnap.length; i += 1) {
    const src = splatSnap[i];
    const id = src.id != null ? src.id : `anon-${i}-${src.x}-${src.y}-${src.amount}`;
    if (board._splatSeen.has(id)) continue;
    board._splatSeen.add(id);
    const age = Number(src.age);
    board.splats.push({
      id,
      x: mx(src.x),
      // Reconstruct birth height so the first paint is not mid-rise.
      y: src.y + (Number.isFinite(age) ? age * CONFIG.splatRise : 0),
      amount: src.amount,
      kind: src.kind,
      age: 0,
    });
  }
}

function syncProjectiles(board, shots, mx) {
  const prev = board.projectiles || [];
  const byId = new Map();
  for (let i = 0; i < prev.length; i += 1) {
    const shot = prev[i];
    if (shot && shot.id != null) byId.set(shot.id, shot);
  }
  // Skip puffs on the first sync so reconnects do not smoke every in-flight shell.
  const smokeReady = board._smokeReady === true;
  const next = new Array(shots.length);
  for (let i = 0; i < shots.length; i += 1) {
    const data = shots[i];
    const id = data.id != null ? data.id : i;
    const existing = byId.get(id);
    const isNew = !existing;
    const shot = existing || {};
    const x = mx(data.x);
    const y = data.y;
    notePointMotion(shot, x, y, SHOT_SNAP_PX);
    shot.id = id;
    shot.size = data.size;
    shot.color = data.color;
    if (isNew && smokeReady) spawnGunSmoke(board, x, y, data.size, data.color);
    next[i] = shot;
  }
  board.projectiles = next;
  board._smokeReady = true;
}

function makeTroop(data, side, mx) {
  return writeTroop(Object.create(troopProto), data, side, mx);
}

function syncTroops(side, dataTroops, mx) {
  const prev = side.troops;
  const byId = new Map();
  for (let i = 0; i < prev.length; i += 1) byId.set(prev[i].id, prev[i]);
  const next = new Array(dataTroops.length);
  for (let i = 0; i < dataTroops.length; i += 1) {
    const data = dataTroops[i];
    const existing = byId.get(data.id);
    next[i] = existing
      ? writeTroop(existing, data, side, mx)
      : makeTroop(data, side, mx);
  }
  side.troops = next;
}

function writeSideFields(side, data, viewId, board) {
  side.board = board;
  side.id = viewId;
  side.capital = viewId === "player" ? CONFIG.playerCapital : CONFIG.enemyCapital;
  side.gold = data.gold;
  side.income = data.income;
  side.land = data.land;
  side.landIncome = data.landIncome;
  side.landInvestRate = data.landInvestRate || 0;
  side.capitalHP = data.capitalHP;
  side.banks = data.banks;
  side.speedMultiplier = data.speedMultiplier;
  side.upgrades = { ...data.upgrades };
  side.upgradeProgress = { ...(data.upgradeProgress || { speed: 0, armor: 0, damage: 0 }) };
  side.targeting = {
    top: (data.targeting && data.targeting.top) || "bastion",
    bottom: (data.targeting && data.targeting.bottom) || "bastion",
  };
}

function makeSide(data, viewId, board, mx) {
  const side = Object.create(sideProto);
  writeSideFields(side, data, viewId, board);
  side.troops = data.troops.map((troop) => makeTroop(troop, side, mx));
  return side;
}

/** Update an existing side in place when possible to cut GC on phones. */
function syncSide(existing, data, viewId, board, mx) {
  if (!existing || existing.id !== viewId) {
    return makeSide(data, viewId, board, mx);
  }
  writeSideFields(existing, data, viewId, board);
  syncTroops(existing, data.troops, mx);
  return existing;
}

function makeCheckpoint(data, board) {
  const town = Object.create(townProto);
  town.board = board;
  town.index = data.index;
  town.x = data.x;
  town.y = data.y;
  town.owner = data.owner;
  town.producing = Boolean(data.producing);
  return town;
}

function syncCheckpoints(board, snapTowns, mx, viewOwner) {
  const prev = board.checkpoints || [];
  const byIndex = new Map();
  for (let i = 0; i < prev.length; i += 1) byIndex.set(prev[i].index, prev[i]);
  const next = new Array(snapTowns.length);
  for (let i = 0; i < snapTowns.length; i += 1) {
    const town = snapTowns[i];
    let row = byIndex.get(town.index);
    if (!row) {
      row = makeCheckpoint({
        index: town.index,
        x: mx(town.x),
        y: town.y,
        owner: viewOwner(town.owner),
        producing: town.producing,
      }, board);
    } else {
      row.board = board;
      row.x = mx(town.x);
      row.y = town.y;
      row.owner = viewOwner(town.owner);
      row.producing = Boolean(town.producing);
    }
    next[i] = row;
  }
  board.checkpoints = next;
}

/**
 * Bind the match-start countdown to the local clock using server-sent
 * remaining ms, so display matches when the server actually starts play.
 */
export function applyCountdownTiming(board, payload) {
  board.countdownEnds = payload.countdownEnds || null;
  if (payload.status === "countdown" && Number.isFinite(payload.countdownLeft)) {
    board.countdownLocalEnd = performance.now() + Math.max(0, payload.countdownLeft);
  } else if (payload.status !== "countdown") {
    board.countdownLocalEnd = null;
  }
  applyUnpauseTiming(board, payload);
}

/** Bind mutual-unpause / reconnect-wait countdown the same way as match-start. */
export function applyUnpauseTiming(board, payload) {
  board.unpauseEnds = payload.unpauseEnds || null;
  board.paused = Boolean(payload.paused);
  board.menuPaused = Boolean(payload.menuPaused);
  board.canPause = Boolean(payload.canPause);
  board.pauseWant = Boolean(payload.pauseWant);
  board.unpauseWant = Boolean(payload.unpauseWant);
  board.pauseAlert = Boolean(payload.pauseAlert);
  board.reconnectWaiting = Boolean(payload.reconnectWaiting);
  board.reconnectWaitEnds = payload.reconnectWaitEnds || null;
  if (Number.isFinite(payload.unpauseLeft) && payload.unpauseEnds) {
    board.unpauseLocalEnd = performance.now() + Math.max(0, payload.unpauseLeft);
  } else if (!payload.unpauseEnds) {
    board.unpauseLocalEnd = null;
  }
  if (Number.isFinite(payload.reconnectWaitLeft) && payload.reconnectWaitEnds) {
    board.reconnectLocalEnd = performance.now() + Math.max(0, payload.reconnectWaitLeft);
  } else if (!payload.reconnectWaitEnds) {
    board.reconnectLocalEnd = null;
  }
}

/** Whole seconds left on the local countdown display. */
export function countdownSecondsLeft(board) {
  if (board.status !== "countdown") return 0;
  if (Number.isFinite(board.countdownLocalEnd)) {
    return Math.max(0, Math.ceil((board.countdownLocalEnd - performance.now()) / 1000));
  }
  if (Number.isFinite(board.countdownEnds)) {
    return Math.max(0, Math.ceil((board.countdownEnds - Date.now()) / 1000));
  }
  return 0;
}

/** Whole seconds left until a mutual pause resumes. */
export function unpauseSecondsLeft(board) {
  if (!board.unpauseEnds && !Number.isFinite(board.unpauseLocalEnd)) return 0;
  if (Number.isFinite(board.unpauseLocalEnd)) {
    return Math.max(0, Math.ceil((board.unpauseLocalEnd - performance.now()) / 1000));
  }
  if (Number.isFinite(board.unpauseEnds)) {
    return Math.max(0, Math.ceil((board.unpauseEnds - Date.now()) / 1000));
  }
  return 0;
}

/** Whole seconds left waiting for a disconnected opponent. */
export function reconnectSecondsLeft(board) {
  if (!board.reconnectWaitEnds && !Number.isFinite(board.reconnectLocalEnd)) return 0;
  if (Number.isFinite(board.reconnectLocalEnd)) {
    return Math.max(0, Math.ceil((board.reconnectLocalEnd - performance.now()) / 1000));
  }
  if (Number.isFinite(board.reconnectWaitEnds)) {
    return Math.max(0, Math.ceil((board.reconnectWaitEnds - Date.now()) / 1000));
  }
  return 0;
}

/**
 * Local controlled side is always the left/"player" view.
 * Seat b (and debug control of the enemy) mirrors onto that view.
 * @param {string} [controlSide] sim side the human is commanding
 */
export function applySnapshot(board, snap, seat, controlSide) {
  // controlSide is debug-only; normal multiplayer mirrors from seat (b → enemy → left/blue).
  const mine = controlSide === "player" || controlSide === "enemy"
    ? controlSide
    : (seat === "b" ? "enemy" : "player");
  const mirror = mine === "enemy";
  const mx = (x) => (mirror ? CONFIG.canvasWidth - x : x);
  const viewOwner = (owner) => {
    if (!owner) return null;
    return owner === mine ? "player" : "enemy";
  };
  installMapView(snap);
  board.mapMeta = snap.map || null;
  board.elapsed = snap.elapsed;
  const prevElapsed = board.motionElapsed;
  const elapsed = Number(snap.elapsed);
  board.motionElapsed = Number.isFinite(elapsed) ? elapsed : prevElapsed;
  if (prevElapsed == null || !Number.isFinite(elapsed)) {
    board.motionGapMs = 0;
  } else {
    const gap = (elapsed - prevElapsed) * 1000;
    board.motionGapMs = gap > 0 && gap < 1000 ? gap : 0;
  }
  board.motionAt = performance.now();
  board.winner = snap.winner ? viewOwner(snap.winner) : null;
  board.winReason = snap.winReason || null;
  board.matchReview = snap.matchReview && typeof snap.matchReview === "object"
    ? snap.matchReview
    : null;
  board.status = snap.status;
  applyCountdownTiming(board, snap);
  const rawCenters = snap.laneCenters || {
    top: snap.topCenter,
    bottom: snap.bottomCenter,
  };
  const first = !board.laneCenterLastAt;
  if (!first) board.presentLaneCenters();
  if (!board.laneCenters) board.laneCenters = {};
  if (!board.laneCentersTo) board.laneCentersTo = {};
  const laneIds = Path.laneIds();
  for (let i = 0; i < laneIds.length; i += 1) {
    const id = laneIds[i];
    let share = rawCenters[id];
    if (share == null) share = 0.5;
    if (mirror) share = 1 - share;
    board.laneCentersTo[id] = share;
    if (first) board.laneCenters[id] = share;
  }
  if (first) board.laneCenterLastAt = performance.now();
  if (board.laneCenters.top != null) {
    board.topCenter = board.laneCenters.top;
    board.topCenterTo = board.laneCentersTo.top;
  }
  if (board.laneCenters.bottom != null) {
    board.bottomCenter = board.laneCenters.bottom;
    board.bottomCenterTo = board.laneCentersTo.bottom;
  }
  board.player = syncSide(board.player, snap.sides[mine], "player", board, mx);
  board.enemy = syncSide(
    board.enemy,
    snap.sides[mine === "player" ? "enemy" : "player"],
    "enemy",
    board,
    mx,
  );
  syncCheckpoints(board, snap.checkpoints, mx, viewOwner);
  syncProjectiles(board, snap.projectiles || [], mx);
  syncSplats(board, snap.splats || [], mx, prevElapsed, elapsed);
  board.mapId = snap.mapId || snap.terrain && snap.terrain.mapId || CONFIG.defaultMapId;
  const rawFeatures = (snap.terrain && snap.terrain.features) || [];
  if (!board.terrainFeatures || board.terrainFeatures.length !== rawFeatures.length) {
    board.terrainFeatures = new Array(rawFeatures.length);
  }
  for (let i = 0; i < rawFeatures.length; i += 1) {
    const f = rawFeatures[i];
    const total = Path.lanePaces(f.lane);
    const centerPaces = mirror ? total - f.centerPaces : f.centerPaces;
    const row = board.terrainFeatures[i] || (board.terrainFeatures[i] = {});
    row.id = f.id;
    row.kind = f.kind;
    row.lane = f.lane;
    row.sublanes = f.sublanes.slice();
    row.centerPaces = centerPaces;
    row.halfWidthPaces = f.halfWidthPaces;
    row.sideId = f.sideId;
    row.emoji = TERRAIN_EMOJI[f.kind] || "";
  }
  const rawFog = (snap.terrain && snap.terrain.fogRegions) || [];
  if (!board.fogRegions || board.fogRegions.length !== rawFog.length) {
    board.fogRegions = new Array(rawFog.length);
  }
  for (let i = 0; i < rawFog.length; i += 1) {
    const r = rawFog[i];
    const total = Path.lanePaces(r.lane);
    const row = board.fogRegions[i] || (board.fogRegions[i] = {});
    row.lane = r.lane;
    row.sublane = r.sublane;
    row.fogged = Boolean(r.fogged);
    if (!mirror) {
      row.minPaces = r.minPaces;
      row.maxPaces = r.maxPaces;
    } else {
      row.minPaces = total - r.maxPaces;
      row.maxPaces = total - r.minPaces;
    }
  }
  if (board.drag) {
    const next = board.player.troops.find((troop) => troop.id === board.drag.troop.id);
    if (!next) board.drag = null;
    else board.drag.troop = next;
  }
  return (snap.sounds || []).map((sound) => {
    if (sound.type !== "shoot" && sound.type !== "melee") return sound;
    if (!sound.sideId) return sound;
    return { ...sound, sideId: viewOwner(sound.sideId) || sound.sideId };
  });
}

export function inspectReadout(board) {
  const troop = board.inspectedTroop();
  if (!troop) return null;
  const allies = troop.side.troops;
  const line = lineSize(troop, allies);
  const hp = Math.max(0, Math.round(troop.hp));
  const fatigue = Math.max(0, Math.round(troop.fatigue || 0));
  const maxFatigue = troop.maxFatigue || unitStats(troop.variant || troop.type).fatigue;
  const status = troop.broken ? "   Broken" : "";
  const main = `${unitTypeLabel(troop.variant || troop.type)}   Line x ${line}   ${hp}/${troop.maxHP()}   ${fatigue}/${maxFatigue}${status}`;
  const bonuses = activeBonuses(board, troop, allies);
  return { main, bonuses, order: orderStatus(troop.order, troop.broken) };
}

export function createBoardState(canvas) {
  return Object.assign(Object.create(boardStateMethods), {
    canvas,
    player: null,
    enemy: null,
    checkpoints: [],
    projectiles: [],
    smokePuffs: [],
    splats: [],
    mapId: CONFIG.defaultMapId,
    terrainFeatures: [],
    fogRegions: [],
    drag: null,
    buyDrag: null,
    strategyDrag: null,
    buySelection: {},
    telescope: null,
    telescopeDrag: null,
    telescopeSlide: 0,
    lanePress: null,
    enemyPress: null,
    orderCallout: null,
    gestureHints: null,
    tooltips: false,
    inspectedId: null,
    inspectedSolo: false,
    inspectedLineIds: null,
    hover: null,
    winner: null,
    winReason: null,
    matchReview: null,
    elapsed: 0,
    status: "waiting",
    countdownEnds: null,
    countdownLocalEnd: null,
    paused: false,
    menuPaused: false,
    canPause: false,
    pauseWant: false,
    unpauseWant: false,
    pauseAlert: false,
    unpauseEnds: null,
    unpauseLocalEnd: null,
    reconnectWaiting: false,
    reconnectWaitEnds: null,
    reconnectLocalEnd: null,
    cssScale: 1,
    southpaw: readSouthpaw(),
    terrainLabels: readTerrainLabels(),
    mapMeta: null,
    laneCenters: { top: 0.5, bottom: 0.5 },
    laneCentersTo: { top: 0.5, bottom: 0.5 },
    topCenter: 0.5,
    bottomCenter: 0.5,
    topCenterTo: 0.5,
    bottomCenterTo: 0.5,
    laneCenterLastAt: 0,
    onCommand() {},
    trainingMode: false,
  });
}
