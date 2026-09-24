import { CONFIG } from "../shared/config.js";
import { BUY_UNITS, UNIT_LABELS, UNIT_STATS, UNIT_VARIANTS, unitStats } from "../shared/units.js";
import { Path, distance, quarterSegments, quarterThickness, touchesQuarterLine } from "../shared/path.js";

function drawProjectile(ctx, shot) {
  const shell = UNIT_STATS.troop;
  ctx.beginPath();
  ctx.arc(shot.x, shot.y, shot.size || shell.projectileSize, 0, Math.PI * 2);
  ctx.fillStyle = shot.color || shell.projectileColor;
  ctx.fill();
}

function drawSplat(ctx, splat) {
  const fade = Math.max(0, 1 - splat.age / CONFIG.splatLife);
  const shown = Math.round(splat.amount * 10) / 10;
  const text = shown % 1 === 0 ? String(shown) : shown.toFixed(1);
  const fill = splat.kind === "melee" ? CONFIG.colors.splatMelee : CONFIG.colors.splatShoot;
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.font = "bold 14px Trebuchet MS, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = CONFIG.colors.splatStroke;
  ctx.strokeText(text, splat.x, splat.y);
  ctx.fillStyle = fill;
  ctx.fillText(text, splat.x, splat.y);
  ctx.restore();
}

const viewTroopMethods = {
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

  /** Draw a cannon circle, troop cross-bar, triangle, or diamond, plus an HP bar. */
  draw(ctx) {
    const color = this.side.id === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
    const fill = this.flash > 0 ? "#fff4d2" : color;
    ctx.fillStyle = fill;
    const ordered = this.order === "reform" || this.order === "halt"
      || this.order === "charge" || this.order === "fallback"
      || this.order === "retreat";
    ctx.strokeStyle = this.order === "halt"
      ? CONFIG.colors.halt
      : this.order === "reform"
        ? CONFIG.colors.reform
        : this.order === "charge"
          ? CONFIG.colors.charge
          : this.order === "fallback"
            ? CONFIG.colors.fallback
            : this.order === "retreat"
              ? CONFIG.colors.retreat
              : "#0d1218";
    ctx.lineWidth = ordered ? 3 : 2;

    const r = this.bodyRadius();
    if (this.alternate) {
      const pad = r - 1;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(this.x - pad, this.y - pad, pad * 2, pad * 2);
    }
    ctx.fillStyle = fill;
    if (this.type === "cannon") {
      ctx.beginPath();
      ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (this.type === "skirmisher") {
      ctx.beginPath();
      ctx.moveTo(this.x, this.y - r);
      ctx.lineTo(this.x + r, this.y + r);
      ctx.lineTo(this.x - r, this.y + r);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (this.type === "dragoon") {
      ctx.beginPath();
      ctx.moveTo(this.x, this.y - r);
      ctx.lineTo(this.x + r, this.y);
      ctx.lineTo(this.x, this.y + r);
      ctx.lineTo(this.x - r, this.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (this.type === "officer") {
      const s = r * 0.75;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineWidth = ordered ? 5 : 4;
      ctx.beginPath();
      ctx.moveTo(this.x - s, this.y - s);
      ctx.lineTo(this.x + s, this.y + s);
      ctx.moveTo(this.x + s, this.y - s);
      ctx.lineTo(this.x - s, this.y + s);
      ctx.stroke();
      ctx.strokeStyle = fill;
      ctx.lineWidth = ordered ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(this.x - s, this.y - s);
      ctx.lineTo(this.x + s, this.y + s);
      ctx.moveTo(this.x + s, this.y - s);
      ctx.lineTo(this.x - s, this.y + s);
      ctx.stroke();
      ctx.restore();
    } else {
      const tan = this.laneTangent();
      const nx = -tan.y;
      const ny = tan.x;
      const len = r * 0.6;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineWidth = ordered ? 12 : 10;
      ctx.beginPath();
      ctx.moveTo(this.x - nx * len, this.y - ny * len);
      ctx.lineTo(this.x + nx * len, this.y + ny * len);
      ctx.stroke();
      ctx.strokeStyle = fill;
      ctx.lineWidth = ordered ? 8 : 6;
      ctx.stroke();
      ctx.restore();
    }

    const board = this.side.board;
    const barW = this.bodyRadius() * 2;
    const barH = 3;
    const barGap = 1;
    const selR = 3;
    const selGap = 2;
    const stackH = barH + barGap + barH + selGap + selR * 2;
    // Bottom-lane telescope rotates the camera; keep bars across the unit.
    const align = Boolean(board && board.telescope && this.lane === "bottom");
    ctx.save();
    let ox = this.x;
    let oy = this.y;
    if (align) {
      const tan = this.laneTangent();
      ctx.translate(this.x, this.y);
      ctx.rotate(Math.atan2(tan.y, tan.x));
      ox = 0;
      oy = 0;
    }
    const stackTop = (oy - stackH / 2) + 2;
    const ratio = Math.max(0, this.hp) / this.maxHP();
    const barX = ox - barW / 2;
    const barY = stackTop;
    const fillW = barW * ratio;
    // Southpaw mirrors the board, so fill from the other end and it still
    // grows from the left side of the unit on screen.
    const fillX = board && board.southpaw
      ? barX + barW - fillW
      : barX;
    ctx.fillStyle = "#1a1510";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = CONFIG.colors.gold;
    ctx.fillRect(fillX, barY, fillW, barH);

    const maxFatigue = this.maxFatigue || unitStats(this.variant || this.type).fatigue || 100;
    const fatigueRatio = Math.max(0, Math.min(1, (this.fatigue || 0) / maxFatigue));
    const fatY = barY + barH + barGap;
    const fatW = barW * fatigueRatio;
    const fatX = board && board.southpaw
      ? barX + barW - fatW
      : barX;
    ctx.fillStyle = "#1a1510";
    ctx.fillRect(barX, fatY, barW, barH);
    ctx.fillStyle = CONFIG.colors.fatigue;
    ctx.fillRect(fatX, fatY, fatW, barH);

    if (board && board.inspectedLineIds && board.inspectedLineIds[this.id]) {
      const selY = fatY + barH + selGap + selR;
      ctx.beginPath();
      ctx.arc(ox, selY, selR, 0, Math.PI * 2);
      if (board.inspectedId === this.id) {
        ctx.fillStyle = "#ff3b30";
        ctx.fill();
      } else {
        ctx.strokeStyle = "#ff3b30";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
};

const viewTownMethods = {
  /**
   * Closest and farthest towns are speed, the next pair are armor,
   * and the middle town is damage.
   */
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

  /** Draw the point in owner color, or tan while still neutral. */
  draw(ctx) {
    const color = this.owner === "player"
      ? CONFIG.colors.player
      : this.owner === "enemy"
        ? CONFIG.colors.enemy
        : CONFIG.colors.neutral;

    const r = this.radius();
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 3 * CONFIG.uiScale;
    ctx.strokeStyle = "#0d1218";
    ctx.stroke();

    if (this.owner === "player" && this.board.player
        && this.board.player.canBuyUpgrade(this.upgradeKind())) {
      ctx.beginPath();
      ctx.arc(this.x, this.y, r + 5 * CONFIG.uiScale, 0, Math.PI * 2);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2 * CONFIG.uiScale;
      ctx.stroke();
    }

    const kind = this.upgradeKind();
    const label = kind === "speed" ? "⚡" : kind === "armor" ? "🛡️" : "⚔️";
    ctx.fillStyle = "#0d1218";
    ctx.font = this.board.uiFont(10);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, this.x, this.y);
    this.drawUpgradeCost(ctx, kind, r);
  },

  /** Land price of this town's upgrade, just above the circle. */
  drawUpgradeCost(ctx, kind, r) {
    if (!this.board.player) return;
    const maxed = this.board.player.upgrades[kind] >= CONFIG.upgradeMax;
    const cost = maxed ? "MAX" : `${this.board.player.upgradeCost(kind)}🌿`;
    const y = this.y - r - 6 * CONFIG.uiScale;
    ctx.save();
    ctx.font = this.board.uiFont(13);
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#0d1218";
    ctx.strokeText(cost, this.x, y);
    ctx.fillStyle = CONFIG.colors.gold;
    ctx.fillText(cost, this.x, y);
    ctx.restore();
  }
};

const viewSideMethods = {
  /** Land price of the next rank of this upgrade. */
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

  /** Draw the capital city and the remaining keep HP beneath it. */
  drawCapital(ctx) {
    const color = this.id === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
    const dark = this.id === "player" ? CONFIG.colors.playerDark : CONFIG.colors.enemyDark;
    const { x, y } = this.capital;

    ctx.beginPath();
    ctx.arc(x, y, CONFIG.capitalRadius, 0, Math.PI * 2);
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  },

  /** Three unlockable banks above the keep. */
  drawBanks(ctx) {
    const nextCost = this.bankCost();
    for (let i = 0; i < CONFIG.bankCount; i += 1) {
      const box = this.bankButtonRect(i);
      const open = i < this.banks;
      const next = i === this.banks;
      const timed = this.bankUnlockedByTime(i);
      const ready = next && timed && this.gold >= nextCost;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      ctx.fillStyle = open ? CONFIG.colors.gold : "#2a3340";
      ctx.strokeStyle = ready ? "#ffffff" : "#0d1218";
      ctx.lineWidth = 2;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      if (!open && !timed) {
        const at = CONFIG.bankUnlockAt[i] || 1;
        const start = i > 0 ? CONFIG.bankUnlockAt[i - 1] : 0;
        const span = Math.max(1, at - start);
        const done = Math.max(0, Math.min(1, (this.board.elapsed - start) / span));
        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x, box.y, box.w, box.h);
        ctx.clip();
        ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, box.w, -Math.PI / 2 + done * Math.PI * 2, -Math.PI / 2 + Math.PI * 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.font = this.board.uiFont(18);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("🏛️", cx, cy);
    }
  }
};

const boardMethods = {
  /** Letterbox the board into the stage and keep a sharp backing store. */
  fitCanvas() {
    const stage = this.canvas.parentElement;
    const availW = Math.max(1, stage.clientWidth);
    const availH = Math.max(1, stage.clientHeight);
    const aspect = CONFIG.canvasWidth / CONFIG.canvasHeight;
    let cssW = availW;
    let cssH = cssW / aspect;
    if (cssH > availH) {
      cssH = availH;
      cssW = cssH * aspect;
    }
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(CONFIG.canvasWidth * dpr);
    this.canvas.height = Math.round(CONFIG.canvasHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssScale = cssW / CONFIG.canvasWidth;
  },

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

  /** Stroke every sublane so the 5-wide top and 3-wide U are visible. */
  drawLanes(ctx) {
    const left = CONFIG.playerCapital;
    const right = CONFIG.enemyCapital;

    ctx.fillStyle = CONFIG.colors.topLane;
    ctx.fillRect(
      left.x,
      left.y - CONFIG.topLaneHeight / 2,
      right.x - left.x,
      CONFIG.topLaneHeight,
    );

    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    ctx.strokeStyle = CONFIG.colors.topSublane;
    ctx.lineWidth = CONFIG.topSublaneWidth;
    for (let s = 0; s < CONFIG.topSublaneCount; s += 1) {
      const pts = Path.worldPoints("top", s);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
    }

    ctx.strokeStyle = CONFIG.colors.bottomSublane;
    ctx.lineWidth = CONFIG.bottomSublaneWidth;
    const ring = Path.bottomCenter();
    for (let s = 0; s < CONFIG.bottomSublaneCount; s += 1) {
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, Path.bottomRadius(s), Math.PI, 0, true);
      ctx.stroke();
    }

    this.drawQuarterLines(ctx);
    this.drawTopCenter(ctx);
    this.drawBottomCenter(ctx);
  },

  drawQuarterLines(ctx) {
    const segs = quarterSegments();
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = quarterThickness();
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < segs.length; i += 1) {
      const s = segs[i];
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
    ctx.restore();
  },

  /** Vertical divider on the top band at the cost-weighted center. */
  drawTopCenter(ctx) {
    const left = CONFIG.playerCapital;
    const right = CONFIG.enemyCapital;
    const t = this.topCenter;
    const x = left.x + (right.x - left.x) * t;
    const top = left.y - CONFIG.topLaneHeight / 2;
    const bottom = left.y + CONFIG.topLaneHeight / 2;
    ctx.save();
    ctx.strokeStyle = CONFIG.colors.laneCenter;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
    const playerGps = Math.round(CONFIG.centerIncome * t);
    this.drawLaneBonus(ctx, x, top - 2, `+${playerGps}💰`, "bottom");
  },

  /** Short ray that only crosses the bottom rings. */
  drawBottomCenter(ctx) {
    const c = Path.bottomCenter();
    const t = this.bottomCenter;
    const theta = Math.PI * (1 - t);
    const rIn = Path.bottomRadius(CONFIG.bottomSublaneCount - 1) - 10;
    const rOut = Path.bottomRadius(0) + 10;
    ctx.save();
    ctx.strokeStyle = CONFIG.colors.laneCenter;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    const ox = c.x + rOut * Math.cos(theta);
    const oy = c.y + rOut * Math.sin(theta);
    ctx.beginPath();
    ctx.moveTo(c.x + rIn * Math.cos(theta), c.y + rIn * Math.sin(theta));
    ctx.lineTo(ox, oy);
    ctx.stroke();
    ctx.restore();
    const playerLps = Math.round(CONFIG.centerLand * t);
    const pad = 16;
    this.drawLaneBonus(
      ctx,
      c.x + (rOut + pad) * Math.cos(theta),
      c.y + (rOut + pad) * Math.sin(theta),
      `+${playerLps}🌿`,
      "middle",
    );
  },

  /** Current player's lane bonus, sitting just off one end of the center line. */
  drawLaneBonus(ctx, x, y, text, baseline) {
    ctx.save();
    ctx.font = this.uiFont(12);
    ctx.textAlign = "center";
    ctx.textBaseline = baseline;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#0d1218";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = CONFIG.colors.player;
    ctx.fillText(text, x, y);
    ctx.restore();
  },

  /** Brighten the sublane under the cursor during a row-change drag. */
  drawLaneHover(ctx) {
    if (!this.drag || this.drag.troop.hp <= 0) {
      return;
    }
    const troop = this.drag.troop;
    const row = Path.closestSublane(
      troop.side.id,
      troop.lane,
      troop.progress,
      { x: this.drag.hx, y: this.drag.hy },
    );
    ctx.save();
    ctx.strokeStyle = CONFIG.colors.laneHover;
    ctx.globalAlpha = 0.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (troop.lane === "top") {
      ctx.lineWidth = CONFIG.topSublaneWidth + 6;
      const pts = Path.worldPoints("top", row);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
    } else {
      ctx.lineWidth = CONFIG.bottomSublaneWidth + 6;
      const ring = Path.bottomCenter();
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, Path.bottomRadius(row), Math.PI, 0, true);
      ctx.stroke();
    }
    ctx.restore();
  },

  /** Pointer position in logical canvas pixels, before the southpaw flip. */
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
    const half = Math.min(len / 2, this.telescopeHalf(lane));
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

  drawBattlefield(ctx) {
    this.inspectedTroop();
    this.drawLanes(ctx);
    this.drawLaneHover(ctx);
    for (let i = 0; i < this.checkpoints.length; i += 1) {
      this.checkpoints[i].draw(ctx);
    }
    this.player.drawCapital(ctx);
    this.enemy.drawCapital(ctx);
    const everyone = this.player.troops.concat(this.enemy.troops);
    for (let i = 0; i < everyone.length; i += 1) {
      everyone[i].draw(ctx);
    }
    for (let i = 0; i < this.projectiles.length; i += 1) {
      drawProjectile(ctx, this.projectiles[i]);
    }
    for (let i = 0; i < this.splats.length; i += 1) {
      drawSplat(ctx, this.splats[i]);
    }
  },

  /** Paint the map, checkpoints, keeps, troops, and in-flight shells. */
  render() {
    if (!this.player) return;
    if (this.refreshHoldSelect) this.refreshHoldSelect();
    const ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.telescope) {
      this.stepTelescope();
      ctx.save();
      applySouthpaw(ctx, CONFIG.canvasWidth, this.southpaw);
      const cam = this.telescopeCamera();
      ctx.translate(CONFIG.canvasWidth / 2, CONFIG.canvasHeight / 2);
      ctx.rotate(-cam.angle);
      ctx.scale(cam.scale, cam.scale);
      ctx.translate(-cam.x, -cam.y);
      ctx.fillStyle = CONFIG.colors.bg;
      ctx.fillRect(cam.x - 4000, cam.y - 4000, 8000, 8000);
      this.drawBattlefield(ctx);
      ctx.restore();
      applySouthpaw(ctx, CONFIG.canvasWidth, this.southpaw);
      this.drawScoreboard(ctx);
      this.drawTelescopeHud(ctx);
      return;
    }
    applySouthpaw(ctx, CONFIG.canvasWidth, this.southpaw);
    ctx.clearRect(0, 0, CONFIG.canvasWidth, CONFIG.canvasHeight);
    ctx.fillStyle = CONFIG.colors.bg;
    ctx.fillRect(0, 0, CONFIG.canvasWidth, CONFIG.canvasHeight);
    this.drawBattlefield(ctx);
    this.drawCanvasUI(ctx);
  },

  /** Banks, scoreboard, and buy buttons drawn over the map. */
  drawCanvasUI(ctx) {
    this.player.drawBanks(ctx);
    this.enemy.drawBanks(ctx);
    this.drawScoreboard(ctx);
    this.drawBuyButtons(ctx);
    this.drawInspectedUnit(ctx);
    this.drawOrderCallout(ctx);
  },

  /** The selected unit, or null once it is gone. */
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

  /**
   * Type, line size, health, and live bonuses for the selected unit,
   * centered above the buy row until it dies or another unit is selected.
   */
  drawInspectedUnit(ctx) {
    const troop = this.inspectedTroop();
    if (!troop) return;
    const layout = this.buyRowLayout();
    const allies = troop.side.troops;
    const line = this.inspectedSolo ? 1 : lineSize(troop, allies);
    const hp = Math.max(0, Math.round(troop.hp));
    const fatigue = Math.max(0, Math.round(troop.fatigue || 0));
    const maxFatigue = troop.maxFatigue || unitStats(troop.variant || troop.type).fatigue;
    const status = troop.broken ? "   Broken" : "";
    const main = `${unitTypeLabel(troop.variant || troop.type)}   Line x ${line}   ${hp}/${troop.maxHP()}   ${fatigue}/${maxFatigue}${status}`;
    const bonuses = activeBonuses(this, troop, allies);
    const gap = 6 * CONFIG.uiScale;
    const yBonus = layout.y - gap;
    const yMain = bonuses ? yBonus - 18 * CONFIG.uiScale : yBonus;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#0d1218";
    ctx.font = this.uiFont(16);
    ctx.strokeText(main, CONFIG.canvasWidth / 2, yMain);
    ctx.fillStyle = CONFIG.colors.text;
    ctx.fillText(main, CONFIG.canvasWidth / 2, yMain);
    if (bonuses) {
      ctx.font = this.uiFont(13);
      ctx.strokeText(bonuses, CONFIG.canvasWidth / 2, yBonus);
      ctx.fillStyle = CONFIG.colors.gold;
      ctx.fillText(bonuses, CONFIG.canvasWidth / 2, yBonus);
    }
    ctx.restore();
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

  /**
   * While zoomed: selected unit on the left, order on the right,
   * pinned to the bottom of the screen.
   */
  drawTelescopeHud(ctx) {
    const troop = this.inspectedTroop();
    const call = this.orderCallout;
    let callFade = 0;
    if (call) {
      const left = call.until - performance.now();
      if (left <= 0) this.orderCallout = null;
      else callFade = left < 280 ? left / 280 : 1;
    }
    if (!troop && !this.orderCallout) return;
    const bottom = CONFIG.canvasHeight - 18 * CONFIG.uiScale;
    const leftX = CONFIG.canvasWidth * 0.28;
    const rightX = CONFIG.canvasWidth * 0.72;
    ctx.save();
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#0d1218";
    if (troop) {
      const allies = troop.side.troops;
      const line = this.inspectedSolo ? 1 : lineSize(troop, allies);
      const hp = Math.max(0, Math.round(troop.hp));
      const fatigue = Math.max(0, Math.round(troop.fatigue || 0));
      const maxFatigue = troop.maxFatigue || unitStats(troop.variant || troop.type).fatigue;
      const status = troop.broken ? "   Broken" : "";
      const main = `${unitTypeLabel(troop.variant || troop.type)}   Line x ${line}   ${hp}/${troop.maxHP()}   ${fatigue}/${maxFatigue}${status}`;
      const bonuses = activeBonuses(this, troop, allies);
      const yMain = bonuses ? bottom - 20 * CONFIG.uiScale : bottom;
      ctx.textAlign = "center";
      ctx.font = this.uiFont(16);
      ctx.strokeText(main, leftX, yMain);
      ctx.fillStyle = CONFIG.colors.text;
      ctx.fillText(main, leftX, yMain);
      if (bonuses) {
        ctx.font = this.uiFont(13);
        ctx.strokeText(bonuses, leftX, bottom);
        ctx.fillStyle = CONFIG.colors.gold;
        ctx.fillText(bonuses, leftX, bottom);
      }
    }
    const flash = this.orderCallout;
    const order = flash
      ? { text: flash.text, color: flash.color, fade: callFade }
      : troop
        ? { ...orderStatus(troop.order, troop.broken), fade: 1 }
        : null;
    if (order) {
      ctx.globalAlpha = order.fade;
      ctx.font = this.uiFont(18);
      ctx.strokeText(order.text, rightX, bottom);
      ctx.fillStyle = order.color;
      ctx.fillText(order.text, rightX, bottom);
    }
    ctx.restore();
  },

  drawOrderCallout(ctx) {
    if (this.telescope) return;
    const call = this.orderCallout;
    if (!call) return;
    const left = call.until - performance.now();
    if (left <= 0) {
      this.orderCallout = null;
      return;
    }
    const fade = left < 280 ? left / 280 : 1;
    const layout = this.buyRowLayout();
    const y = layout.y + layout.h + 10 * CONFIG.uiScale;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = this.uiFont(18);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#0d1218";
    ctx.strokeText(call.text, CONFIG.canvasWidth / 2, y);
    ctx.fillStyle = call.color;
    ctx.fillText(call.text, CONFIG.canvasWidth / 2, y);
    ctx.restore();
  },

  /** Player and bot stats plus keep score, between the two bank rows. */
  drawScoreboard(ctx) {
    const pLast = this.player.bankButtonRect(CONFIG.bankCount - 1);
    const eFirst = this.enemy.bankButtonRect(0);
    const left = pLast.x + pLast.w + 14 * CONFIG.uiScale;
    const right = eFirst.x - 14 * CONFIG.uiScale;
    const mid = (left + right) / 2;
    const top = pLast.y;
    const midY = top + pLast.h / 2;
    this.drawSideStats(ctx, this.player, left, midY, "left");
    this.drawSideStats(ctx, this.enemy, right, midY, "right");
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = this.uiFont(18);
    ctx.fillStyle = CONFIG.colors.player;
    ctx.fillText(String(Math.max(0, this.player.capitalHP)), mid - 28 * CONFIG.uiScale, midY);
    ctx.fillStyle = CONFIG.colors.text;
    ctx.font = this.uiFont(14);
    ctx.fillText("—", mid, midY);
    ctx.fillStyle = CONFIG.colors.enemy;
    ctx.font = this.uiFont(18);
    ctx.fillText(String(Math.max(0, this.enemy.capitalHP)), mid + 28 * CONFIG.uiScale, midY);
    ctx.restore();
  },

  drawSideStats(ctx, side, x, midY, align) {
    const gold = Math.floor(side.gold);
    const land = Math.floor(side.land);
    const line1 = `${gold}💰 +${side.income}/s   ${land}🌿 +${side.landIncome}/s`;
    const line2 = `${side.speedMultiplier.toFixed(2)}x ⚡  ${side.damageScale().toFixed(2)}x ⚔️  ${Math.round(side.armorReduction() * 100)}% 🛡️`;
    ctx.save();
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = side.id === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
    ctx.font = this.uiFont(12);
    ctx.fillText(line1, x, midY - 8 * CONFIG.uiScale);
    ctx.fillStyle = CONFIG.colors.text;
    ctx.font = this.uiFont(11, "normal");
    ctx.fillText(line2, x, midY + 9 * CONFIG.uiScale);
    ctx.restore();
  },

  drawBuyButtons(ctx) {
    const hover = this.hover;
    const over = Boolean(this.winner) || this.status !== "playing";
    const drag = this.buyDrag;
    const showUnlock = this.player && this.player.land >= CONFIG.variantUnlockCost;
    for (let i = 0; i < BUY_UNITS.length; i += 1) {
      const unit = BUY_UNITS[i];
      const variant = UNIT_VARIANTS[unit.type];
      const spawn = this.selectedBuyUnit(unit.type);
      const stats = unitStats(spawn);
      const box = this.buyButtonRect(i);
      const cost = stats.cost;
      const can = !over && this.player.gold >= cost;
      const lit = hover
        && hover.x >= box.x && hover.x <= box.x + box.w
        && hover.y >= box.y && hover.y <= box.y + box.h;
      const lane = drag && drag.index === i ? drag.lane : null;
      const mid = box.y + box.h / 2;
      const cx = box.x + box.w / 2;
      ctx.globalAlpha = can ? 1 : 0.45;
      ctx.fillStyle = unit.fill;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      if (spawn !== unit.type) {
        const pad = 5 * CONFIG.uiScale;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(box.x + pad, box.y + pad, box.w - pad * 2, box.h - pad * 2);
        ctx.fillStyle = unit.fill;
        ctx.fillRect(box.x + pad + 2, box.y + pad + 2, box.w - pad * 2 - 4, box.h - pad * 2 - 4);
      }
      if (lane) {
        ctx.fillStyle = "rgba(255,255,255,0.22)";
        ctx.fillRect(box.x, lane === "top" ? box.y : mid, box.w, box.h / 2);
      }
      ctx.strokeStyle = can && (lit || lane) ? "#ffffff" : unit.stroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = lane === "top" ? "#ffffff" : "#9ee8c8";
      fillChevron(ctx, cx, box.y + box.h * 0.14, true);
      ctx.fillStyle = lane === "bottom" ? "#ffffff" : "#e8c36a";
      fillChevron(ctx, cx, box.y + box.h * 0.86, false);
      if (variant && this.player.unlockedVariants[variant]) {
        const edge = 7 * CONFIG.uiScale;
        ctx.fillStyle = "#ffffff";
        fillSideArrow(ctx, box.x + edge, mid, false);
        fillSideArrow(ctx, box.x + box.w - edge, mid, true);
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = this.uiFont(12);
      ctx.fillStyle = CONFIG.colors.text;
      ctx.fillText(UNIT_LABELS[spawn] || unit.label, cx, mid - 8 * CONFIG.uiScale);
      ctx.fillStyle = CONFIG.colors.gold;
      ctx.font = this.uiFont(11);
      ctx.fillText(`${cost}💰`, cx, mid + 9 * CONFIG.uiScale);
      ctx.globalAlpha = 1;

      if (showUnlock && variant && !this.player.unlockedVariants[variant]) {
        const ubox = this.variantUnlockRect(i);
        const canUnlock = !over && this.player.land >= CONFIG.variantUnlockCost;
        const uLit = hover
          && hover.x >= ubox.x && hover.x <= ubox.x + ubox.w
          && hover.y >= ubox.y && hover.y <= ubox.y + ubox.h;
        ctx.globalAlpha = canUnlock ? 1 : 0.45;
        ctx.fillStyle = "#2a3340";
        ctx.fillRect(ubox.x, ubox.y, ubox.w, ubox.h);
        ctx.strokeStyle = canUnlock && uLit ? "#ffffff" : unit.stroke;
        ctx.lineWidth = 2;
        ctx.strokeRect(ubox.x, ubox.y, ubox.w, ubox.h);
        ctx.fillStyle = CONFIG.colors.gold;
        ctx.font = this.uiFont(10);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${CONFIG.variantUnlockCost}🌿`, ubox.x + ubox.w / 2, ubox.y + ubox.h / 2);
        ctx.globalAlpha = 1;
      }
    }
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
const nativeText = new WeakMap();

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

function nativeTextFns(ctx) {
  let saved = nativeText.get(ctx);
  if (!saved) {
    saved = {
      fill: ctx.fillText.bind(ctx),
      stroke: ctx.strokeText.bind(ctx),
    };
    nativeText.set(ctx, saved);
  }
  return saved;
}

/**
 * Mirror the view so the player side is on the right. Glyphs stay readable:
 * each text call is flipped back, and left/right alignment swaps so labels
 * still sit inside the mirrored buttons and scoreboard.
 */
export function applySouthpaw(ctx, width, on) {
  const saved = nativeTextFns(ctx);
  if (!on) {
    ctx.fillText = saved.fill;
    ctx.strokeText = saved.stroke;
    return;
  }
  ctx.translate(width, 0);
  ctx.scale(-1, 1);
  const mirror = (fn) => (text, x, y, maxWidth) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(-1, 1);
    if (ctx.textAlign === "left") ctx.textAlign = "right";
    else if (ctx.textAlign === "right") ctx.textAlign = "left";
    if (maxWidth === undefined) fn(text, 0, 0);
    else fn(text, 0, 0, maxWidth);
    ctx.restore();
  };
  ctx.fillText = mirror(saved.fill);
  ctx.strokeText = mirror(saved.stroke);
}

function fillChevron(ctx, cx, cy, up) {
  const s = 4 * CONFIG.uiScale;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(cx, cy - s * 0.55);
    ctx.lineTo(cx - s, cy + s * 0.45);
    ctx.lineTo(cx + s, cy + s * 0.45);
  } else {
    ctx.moveTo(cx, cy + s * 0.55);
    ctx.lineTo(cx - s, cy - s * 0.45);
    ctx.lineTo(cx + s, cy - s * 0.45);
  }
  ctx.closePath();
  ctx.fill();
}

function fillSideArrow(ctx, cx, cy, right) {
  const s = 3.5 * CONFIG.uiScale;
  ctx.beginPath();
  if (right) {
    ctx.moveTo(cx + s * 0.55, cy);
    ctx.lineTo(cx - s * 0.45, cy - s);
    ctx.lineTo(cx - s * 0.45, cy + s);
  } else {
    ctx.moveTo(cx - s * 0.55, cy);
    ctx.lineTo(cx + s * 0.45, cy - s);
    ctx.lineTo(cx + s * 0.45, cy + s);
  }
  ctx.closePath();
  ctx.fill();
}

function makeTroop(data, side, mx) {
  const troop = Object.create(viewTroopMethods);
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
  const side = Object.create(viewSideMethods);
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
  const town = Object.create(viewTownMethods);
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

export function createBoard(canvas) {
  const board = Object.assign(Object.create(boardMethods), {
    canvas,
    ctx: canvas.getContext("2d"),
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
  board.fitCanvas();
  if (window.ResizeObserver && canvas.parentElement) {
    const observer = new ResizeObserver(() => board.fitCanvas());
    observer.observe(canvas.parentElement);
  }
  return board;
}
