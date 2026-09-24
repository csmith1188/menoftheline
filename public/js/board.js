import { CONFIG } from "../shared/config.js";
import { BUY_UNITS, UNIT_LABELS, UNIT_STATS, UNIT_VARIANTS, unitStats } from "../shared/units.js";
import { Path, distance, touchesQuarterLine } from "../shared/path.js";

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
  upgradeKind() {
    const last = CONFIG.checkpointCount - 1;
    const dist = Math.min(this.index, last - this.index);
    if (dist === 0) {
      return "speed";
    }
    if (dist === 1) {
      return "armor";
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

  /** True when this upgrade is below the tier cap and can be paid for. */
  canBuyUpgrade(kind) {
    if (this.upgrades[kind] === undefined || this.upgrades[kind] >= CONFIG.upgradeMax) {
      return false;
    }
    return this.land >= this.upgradeCost(kind);
  },

  /** Incoming damage multiplier after armor ranks. */
  armorReduction() {
    return Math.min(CONFIG.armorCap, CONFIG.armorPerUpgrade * this.upgrades.armor);
  },

  /** Outgoing damage multiplier from damage ranks. */
  damageScale() {
    return 1 + CONFIG.damageUpgradeAmount * this.upgrades.damage;
  },

  /** Gold to unlock the next bank. */
  bankCost() {
    return CONFIG.bankBaseCost + CONFIG.bankCostStep * this.banks;
  },

  /** World box of one bank button above this capital, kept inside the keep. */
  bankButtonRect(index) {
    const ui = this.board.uiMetrics();
    const size = ui.bank;
    const gap = ui.bankGap;
    const count = CONFIG.bankCount;
    const total = count * size + (count - 1) * gap;
    const edge = CONFIG.capitalRadius;
    const x = this.id === "player"
      ? this.capital.x - edge + index * (size + gap)
      : this.capital.x + edge - total + index * (size + gap);
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

  uiFont(px, weight) {
    const size = Math.round(px * CONFIG.uiScale);
    return `${weight || "bold"} ${size}px Trebuchet MS, sans-serif`;
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
    return {
      buyW,
      buyH,
      buyGap: (coarse ? 8 : CONFIG.buyButtonGap) * grow,
      bank,
      bankGap: (coarse ? 8 : CONFIG.bankButtonGap) * grow,
      hitPad: Math.max(6, (CONFIG.touchTargetPx / scale - Math.min(buyH, bank)) / 2),
      unitReach: Math.max(10, 24 / scale),
      townReach: Math.max(12, 24 / scale),
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
    const mine = this.hitSideTroopAt(point, this.player);
    const theirs = this.hitSideTroopAt(point, this.enemy);
    if (!mine) return theirs;
    if (!theirs) return mine;
    return distance(point, mine) <= distance(point, theirs) ? mine : theirs;
  },

  hitSideTroopAt(point, side) {
    if (!side) return null;
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

  /** Unlock button under a buy slot, when land is high enough and the variant is still locked. */
  hitVariantUnlockAt(point) {
    if (!this.player || this.player.land < CONFIG.variantUnlockCost) return null;
    const pad = this.uiMetrics().hitPad;
    for (let i = 0; i < BUY_UNITS.length; i += 1) {
      const base = BUY_UNITS[i].type;
      const variant = UNIT_VARIANTS[base];
      if (!variant || this.player.unlockedVariants[variant]) continue;
      const box = this.variantUnlockRect(i);
      if (this.pointInBox(point, box, pad)) {
        return { index: i, base, variant };
      }
    }
    return null;
  },

  /** Spawn key currently shown on this buy button. Unlocked alternates default on. */
  selectedBuyUnit(base) {
    const variant = UNIT_VARIANTS[base];
    const unlocked = Boolean(
      variant && this.player && this.player.unlockedVariants[variant],
    );
    if (!unlocked) return base;
    const pick = this.buySelection && this.buySelection[base];
    if (pick === base || pick === variant) return pick;
    return variant;
  },

  /** Cycle base ↔ unlocked alternate. dir is -1 left or +1 right. */
  cycleBuyVariant(base, dir) {
    const variant = UNIT_VARIANTS[base];
    if (!variant || !this.player || !this.player.unlockedVariants[variant]) return false;
    if (!this.buySelection) this.buySelection = {};
    const options = [base, variant];
    const cur = this.selectedBuyUnit(base);
    let idx = options.indexOf(cur);
    if (idx < 0) idx = 0;
    this.buySelection[base] = options[(idx + dir + options.length) % options.length];
    return true;
  },

  /** When a variant is newly unlocked, switch that buy slot to the alternate. */
  syncBuySelection(prevUnlocked) {
    if (!this.buySelection) this.buySelection = {};
    const unlocked = (this.player && this.player.unlockedVariants) || {};
    for (let i = 0; i < BUY_UNITS.length; i += 1) {
      const base = BUY_UNITS[i].type;
      const variant = UNIT_VARIANTS[base];
      if (!variant || !unlocked[variant]) continue;
      if (!(prevUnlocked && prevUnlocked[variant])) {
        this.buySelection[base] = variant;
      }
    }
  },

  /**
   * One centered row in the open gap under the top lane.
   * Unlock chips sit under the row without shifting it.
   */
  buyRowLayout() {
    const ui = this.uiMetrics();
    const needsUnlockRow = Boolean(
      this.player
      && this.player.land >= CONFIG.variantUnlockCost
      && BUY_UNITS.some((unit) => {
        const variant = UNIT_VARIANTS[unit.type];
        return variant && !this.player.unlockedVariants[variant];
      }),
    );
    const unlockH = needsUnlockRow ? Math.round(ui.buyH * 0.42) : 0;
    const gap = unlockH ? 4 * CONFIG.uiScale : 0;
    const h = ui.buyH;
    const row = BUY_UNITS.length * ui.buyW + (BUY_UNITS.length - 1) * ui.buyGap;
    const x = CONFIG.canvasWidth / 2 - row / 2;
    const pad = 12;
    const minY = CONFIG.playerCapital.y + CONFIG.topLaneHeight / 2 + pad;
    const c = Path.bottomCenter();
    const rIn = Path.bottomRadius(CONFIG.bottomSublaneCount - 1);
    const dx = Math.min(row / 2, rIn - 8);
    const ringY = c.y + Math.sqrt(Math.max(0, rIn * rIn - dx * dx));
    const maxY = ringY - pad - h;
    let y = (minY + maxY) / 2;
    y = Math.max(minY, Math.min(y, maxY));
    return { x, y, h, unlockH, unlockGap: gap, ui };
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

  variantUnlockRect(index) {
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
    const left = CONFIG.playerCapital;
    const right = CONFIG.enemyCapital;
    const top = left.y - CONFIG.topLaneHeight / 2;
    const bottom = left.y + CONFIG.topLaneHeight / 2;
    if (point.y >= top && point.y <= bottom && point.x >= left.x && point.x <= right.x) {
      return { lane: "top", along: Path.stationAt("top", point.x, point.y) };
    }
    const c = Path.bottomCenter();
    const dx = point.x - c.x;
    const dy = point.y - c.y;
    if (dy < 0) return null;
    const dist = Math.hypot(dx, dy);
    const outer = Path.bottomRadius(0) + CONFIG.bottomSublaneWidth / 2;
    const inner = Path.bottomRadius(CONFIG.bottomSublaneCount - 1) - CONFIG.bottomSublaneWidth / 2;
    if (dist < inner || dist > outer) return null;
    const along = (Path.stationAt("bottom", point.x, point.y) / 180) * this.laneLength("bottom");
    return { lane: "bottom", along };
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
    const allies = troop.side.troops;
    const group = this.inspectedSolo ? [troop] : lineGroup(troop, allies);
    const ids = {};
    for (let i = 0; i < group.length; i += 1) ids[group[i].id] = true;
    this.inspectedLineIds = ids;
    return troop;
  },

  announceOrder(troop, action) {
    if (troop) {
      this.inspectedId = troop.id;
      this.inspectedTroop();
    }
    const shown = orderAnnouncement(troop, action);
    if (!shown) return;
    this.orderCallout = {
      text: shown.text,
      color: shown.color,
      until: performance.now() + 900,
    };
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

function inLineWith(member, ally) {
  if (ally.hp <= 0 || ally.lane !== member.lane || ally.type !== member.type) return false;
  if (Math.abs(member.sublane - ally.sublane) !== 1) return false;
  return Math.abs(troopStation(member) - troopStation(ally)) <= lineSlack(member);
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

function inMeleeContact(troop, enemies) {
  const stats = troopKindStats(troop);
  if (!stats.fightsMelee) return false;
  const reach = troop.bodyRadius() + CONFIG.meleeSlack;
  for (let i = 0; i < enemies.length; i += 1) {
    const foe = enemies[i];
    if (foe.hp <= 0 || foe.lane !== troop.lane) continue;
    if (!troopKindStats(foe).fightsMelee) continue;
    if (distance(troop, foe) <= reach + foe.bodyRadius()) return true;
  }
  return false;
}

function inCapitalRange(troop) {
  const capital = troop.side && troop.side.capital;
  if (!capital) return false;
  return distance(troop, capital) <= CONFIG.capitalCannonRange;
}

/** Color-guard attack/speed auras currently affecting this unit. */
function auraBonuses(troop, allies) {
  let attack = 1;
  let speed = 1;
  for (let i = 0; i < allies.length; i += 1) {
    const ally = allies[i];
    if (ally === troop || ally.hp <= 0) continue;
    const stats = troopKindStats(ally);
    if (!(stats.buffRange > 0)) continue;
    if (distance(troop, ally) > stats.buffRange) continue;
    if (stats.attackBuff > 0) attack = Math.max(attack, 1 + stats.attackBuff);
    if (stats.speedBuff > 0) speed = Math.max(speed, 1 + stats.speedBuff);
  }
  return { attack, speed };
}

/** True while an officer (or color guard) is restoring this unit's fatigue. */
function underOfficerRestore(troop, allies) {
  for (let i = 0; i < allies.length; i += 1) {
    const ally = allies[i];
    if (ally === troop || ally.hp <= 0) continue;
    const stats = troopKindStats(ally);
    if (!(stats.restoreRate > 0) || !(stats.restoreRange > 0)) continue;
    if (distance(troop, ally) <= stats.restoreRange) return true;
  }
  return false;
}

function shotSlowActive(troop) {
  if (!(troop.shotSlow > 0)) return false;
  return troop.order == null || troop.order === "charge";
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

  const mates = lineSize(troop, allies) - 1;
  if (stats.lineBonus && mates > 0) {
    labels.push(`Line +${Math.round(mates * stats.lineBonus * 100)}%`);
  }

  if (troop.order === "charge" && stats.chargeMultiplier && stats.chargeMultiplier !== 1) {
    labels.push(`Charge ${multText(stats.chargeMultiplier)}`);
  }
  if (hasChargeSpeed(troop)) {
    const label = troop.order === "retreat" ? "Retreat speed" : "Charge speed";
    labels.push(`${label} ${multText(troopKindStats(troop).chargeSpeed)}`);
  }

  let flanking = false;
  for (let i = 0; i < enemies.length; i += 1) {
    if (isFlanking(troop, enemies[i])) {
      flanking = true;
      break;
    }
  }
  if (flanking && stats.flankMultiplier && stats.flankMultiplier !== 1) {
    labels.push(`Flank ${multText(stats.flankMultiplier)}`);
  }

  if (touchesQuarterLine(troop)) {
    labels.push(`Cover +${Math.round(CONFIG.quarterArmor * 100)}%`);
  }

  if (side) {
    if (side.speedMultiplier && side.speedMultiplier !== 1) {
      labels.push(`Upgrade speed ${multText(side.speedMultiplier)}`);
    }
    const armorRanks = side.upgrades ? side.upgrades.armor : 0;
    if (armorRanks > 0) {
      const armor = Math.min(CONFIG.armorCap, CONFIG.armorPerUpgrade * armorRanks);
      labels.push(`Armor +${Math.round(armor * 100)}%`);
    }
    const dmgRanks = side.upgrades ? side.upgrades.damage : 0;
    if (dmgRanks > 0) {
      labels.push(`Upgrade dmg ${multText(1 + CONFIG.damageUpgradeAmount * dmgRanks)}`);
    }
  }

  const aura = auraBonuses(troop, allies);
  if (aura.attack > 1) labels.push(`Aura attack ${multText(aura.attack)}`);
  if (aura.speed > 1) labels.push(`Aura speed ${multText(aura.speed)}`);

  if (shotSlowActive(troop) && stats.slowFactor && stats.slowFactor !== 1) {
    labels.push(`Slowed ${multText(stats.slowFactor)}`);
  }

  if (troop.order === "reform") {
    labels.push(`Reform speed ${multText(CONFIG.reformSpeedFactor)}`);
  } else if (troop.order === "fallback" && !troop.broken) {
    labels.push(`Fallback speed ${multText(CONFIG.reformSpeedFactor)}`);
  }

  if (troop.lane === "bottom") {
    const outer = Path.bottomRadius(0);
    if (outer > 0) {
      const ring = Path.bottomRadius(troop.sublane) / outer;
      if (Math.abs(ring - 1) > 0.01) {
        labels.push(`Ring speed ${multText(ring)}`);
      }
    }
  }

  if (troop.broken) {
    labels.push("Rallying");
  } else if (troop.order === "charge" || troop.order === "retreat"
      || inMeleeContact(troop, enemies)) {
    labels.push("Fatigue rising");
  } else if (underOfficerRestore(troop, allies)) {
    labels.push("Officer restore");
  } else if (inCapitalRange(troop)) {
    labels.push("Recovering");
  } else if (troop.order === "halt") {
    labels.push("Recovering");
  }

  if (stats.speed && stats.speed !== UNIT_STATS.troop.speed) {
    labels.push(`Walk ${multText(stats.speed / UNIT_STATS.troop.speed)}`);
  }

  return labels.join("   ");
}

function orderStatus(order, broken) {
  if (broken) return { text: "Broken", color: CONFIG.colors.fallback };
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
    return orderStatus(ladder[next], false);
  }
  if (action === "cycle") {
    if (troop.order === "halt") return { text: "Reform", color: CONFIG.colors.reform };
    if (troop.order === "reform") return { text: "Advance", color: CONFIG.colors.text };
    return { text: "Halt", color: CONFIG.colors.halt };
  }
  if (action === "charge") {
    return { text: "Charge", color: CONFIG.colors.charge };
  }
  if (action === "fallback") {
    return { text: "Fallback", color: CONFIG.colors.fallback };
  }
  if (action === "lane") return { text: "Lane", color: CONFIG.colors.laneHover };
  return null;
}

const SOUTHPAW_KEY = "motl-southpaw";

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

let troopProto = troopStateMethods;
let townProto = townStateMethods;
let sideProto = sideStateMethods;

/** Canvas drawing mixes these in so troops keep a draw method. */
export function useDrawPrototypes(next) {
  if (next.troop) troopProto = next.troop;
  if (next.town) townProto = next.town;
  if (next.side) sideProto = next.side;
}

function makeTroop(data, side, mx) {
  const troop = Object.create(troopProto);
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
  troop.shotSlow = data.shotSlow || 0;
  troop.priorOrder = data.priorOrder === undefined ? null : data.priorOrder;
  troop.radius = data.radius;
  troop.x = mx(data.x);
  troop.y = data.y;
  troop.order = data.order;
  troop.flash = data.flash;
  troop.progress = data.progress;
  troop.side = side;
  return troop;
}

function makeSide(data, viewId, board, mx) {
  const side = Object.create(sideProto);
  side.board = board;
  side.id = viewId;
  side.capital = viewId === "player" ? CONFIG.playerCapital : CONFIG.enemyCapital;
  side.gold = data.gold;
  side.income = data.income;
  side.land = data.land;
  side.landIncome = data.landIncome;
  side.capitalHP = data.capitalHP;
  side.banks = data.banks;
  side.speedMultiplier = data.speedMultiplier;
  side.upgrades = { ...data.upgrades };
  side.unlockedVariants = { ...(data.unlockedVariants || {}) };
  side.troops = data.troops.map((troop) => makeTroop(troop, side, mx));
  return side;
}

function makeCheckpoint(data, board) {
  const town = Object.create(townProto);
  town.board = board;
  town.index = data.index;
  town.x = data.x;
  town.y = data.y;
  town.owner = data.owner;
  return town;
}

/** Local player is always the left side. Seat b is mirrored onto that view. */
export function applySnapshot(board, snap, seat) {
  const mirror = seat === "b";
  const mine = seat === "a" ? "player" : "enemy";
  const mx = (x) => (mirror ? CONFIG.canvasWidth - x : x);
  const viewOwner = (owner) => {
    if (!owner) return null;
    return owner === mine ? "player" : "enemy";
  };
  board.elapsed = snap.elapsed;
  board.winner = snap.winner ? viewOwner(snap.winner) : null;
  board.winReason = snap.winReason || null;
  board.status = snap.status;
  board.countdownEnds = snap.countdownEnds || null;
  board.topCenter = mirror ? 1 - snap.topCenter : snap.topCenter;
  board.bottomCenter = mirror ? 1 - snap.bottomCenter : snap.bottomCenter;
  board.player = makeSide(snap.sides[mine], "player", board, mx);
  board.enemy = makeSide(snap.sides[mine === "player" ? "enemy" : "player"], "enemy", board, mx);
  const prevUnlocked = board.unlockedVariantsSeen || {};
  board.syncBuySelection(prevUnlocked);
  board.unlockedVariantsSeen = { ...(board.player.unlockedVariants || {}) };
  board.checkpoints = snap.checkpoints.map((town) => makeCheckpoint({
    index: town.index,
    x: mx(town.x),
    y: town.y,
    owner: viewOwner(town.owner),
  }, board));
  board.projectiles = snap.projectiles.map((shot) => ({ x: mx(shot.x), y: shot.y }));
  board.splats = snap.splats.map((splat) => ({
    x: mx(splat.x),
    y: splat.y,
    amount: splat.amount,
    kind: splat.kind,
    age: splat.age,
  }));
  if (board.drag) {
    const next = board.player.troops.find((troop) => troop.id === board.drag.troop.id);
    if (!next) board.drag = null;
    else board.drag.troop = next;
  }
  return (snap.sounds || []).map((sound) => {
    if (sound.type !== "shoot") return sound;
    return { ...sound, sideId: viewOwner(sound.sideId) || sound.sideId };
  });
}

export function inspectReadout(board) {
  const troop = board.inspectedTroop();
  if (!troop) return null;
  const allies = troop.side.troops;
  const line = board.inspectedSolo ? 1 : lineSize(troop, allies);
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
    splats: [],
    drag: null,
    buyDrag: null,
    buySelection: {},
    telescope: null,
    telescopeDrag: null,
    telescopeSlide: 0,
    lanePress: null,
    enemyPress: null,
    orderCallout: null,
    inspectedId: null,
    inspectedSolo: false,
    inspectedLineIds: null,
    hover: null,
    winner: null,
    winReason: null,
    elapsed: 0,
    status: "waiting",
    countdownEnds: null,
    cssScale: 1,
    southpaw: readSouthpaw(),
    topCenter: 0.5,
    bottomCenter: 0.5,
    onCommand() {},
  });
}
