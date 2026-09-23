import { BUY_UNITS, CONFIG } from "../shared/config.js";
import { Path, distance, quarterSegments, quarterThickness, touchesQuarterLine } from "../shared/path.js";

function drawProjectile(ctx, shot) {
  ctx.beginPath();
  ctx.arc(shot.x, shot.y, CONFIG.projectileRadius, 0, Math.PI * 2);
  ctx.fillStyle = CONFIG.colors.projectile;
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
    if (this.type === "cannon") {
      return CONFIG.cannonRadius;
    }
    if (this.type === "skirmisher") {
      return CONFIG.skirmisherRadius;
    }
    return CONFIG.troopRadius;
  },

  maxHP() {
    return this.type === "skirmisher" ? CONFIG.skirmisherHP : CONFIG.troopHP;
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
      || this.order === "charge" || this.order === "fallback";
    ctx.strokeStyle = this.order === "halt"
      ? CONFIG.colors.halt
      : this.order === "reform"
        ? CONFIG.colors.reform
        : this.order === "charge"
          ? CONFIG.colors.charge
          : this.order === "fallback"
            ? CONFIG.colors.fallback
            : "#0d1218";
    ctx.lineWidth = ordered ? 3 : 2;

    if (this.type === "cannon") {
      const r = CONFIG.cannonRadius;
      ctx.beginPath();
      ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (this.type === "skirmisher") {
      const r = CONFIG.skirmisherRadius;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y - r);
      ctx.lineTo(this.x + r, this.y + r);
      ctx.lineTo(this.x - r, this.y + r);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (this.type === "dragoon") {
      const r = CONFIG.troopRadius;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y - r);
      ctx.lineTo(this.x + r, this.y);
      ctx.lineTo(this.x, this.y + r);
      ctx.lineTo(this.x - r, this.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      const tan = this.laneTangent();
      const nx = -tan.y;
      const ny = tan.x;
      const len = CONFIG.troopRadius * 0.6;
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

    const barW = this.bodyRadius() * 2;
    const barH = 3;
    const ratio = Math.max(0, this.hp) / this.maxHP();
    ctx.fillStyle = "#1a1510";
    ctx.fillRect(this.x - barW / 2, this.y - barH / 2, barW, barH);
    ctx.fillStyle = CONFIG.colors.gold;
    ctx.fillRect(this.x - barW / 2, this.y - barH / 2, barW * ratio, barH);
    if (this.side.board && this.side.board.inspectedId === this.id) {
      ctx.beginPath();
      ctx.arc(this.x, this.y + barH / 2 + 5, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ff3b30";
      ctx.fill();
    }
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
      ? Math.min(34, Math.max(CONFIG.buyButtonH, tap * 0.55))
      : CONFIG.buyButtonH) * grow;
    const buyW = (coarse ? Math.max(CONFIG.buyButtonW, 108) : CONFIG.buyButtonW) * grow;
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

  /** Map a pointer onto logical canvas pixels (CSS size and DPR independent). */
  canvasPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (CONFIG.canvasWidth / rect.width),
      y: (event.clientY - rect.top) * (CONFIG.canvasHeight / rect.height),
    };
  },

  /** Closest friendly troop under the cursor, or null. */
  hitTroop(event) {
    const point = this.canvasPoint(event);
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < this.player.troops.length; i += 1) {
      const troop = this.player.troops[i];
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

  /**
   * One centered row in the open gap under the top lane. Each button
   * is twice as tall as a single lane button used to be.
   */
  buyRowLayout() {
    const ui = this.uiMetrics();
    const h = ui.buyH * 2;
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
    return { x, y, h, ui };
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

  /** Owned town under the cursor, or null. */
  hitCheckpoint(event) {
    const point = this.canvasPoint(event);
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
    this.drawLaneBonus(ctx, x, top - 2, `${playerGps}🪙`, "bottom");
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
      `${playerLps}🌿`,
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

  /** Paint the map, checkpoints, keeps, troops, and in-flight shells. */
  render() {
    if (!this.player) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CONFIG.canvasWidth, CONFIG.canvasHeight);
    ctx.fillStyle = CONFIG.colors.bg;
    ctx.fillRect(0, 0, CONFIG.canvasWidth, CONFIG.canvasHeight);
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

  /** The unit last given an order, or null once it is gone. */
  inspectedTroop() {
    if (this.inspectedId == null || !this.player) return null;
    const troop = this.player.troops.find((unit) => unit.id === this.inspectedId);
    if (!troop || troop.hp <= 0) {
      this.inspectedId = null;
      return null;
    }
    return troop;
  },

  /**
   * Type, line size, health, and live bonuses for the last ordered unit,
   * centered above the buy row until it dies or another unit is ordered.
   */
  drawInspectedUnit(ctx) {
    const troop = this.inspectedTroop();
    if (!troop) return;
    const layout = this.buyRowLayout();
    const allies = this.player.troops;
    const line = lineSize(troop, allies);
    const hp = Math.max(0, Math.round(troop.hp));
    const main = `${unitTypeLabel(troop.type)}   Line ${line}   ${hp}/${troop.maxHP()}`;
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
    if (troop) this.inspectedId = troop.id;
    const shown = orderAnnouncement(troop, action);
    if (!shown) return;
    this.orderCallout = {
      text: shown.text,
      color: shown.color,
      until: performance.now() + 900,
    };
  },

  drawOrderCallout(ctx) {
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
    for (let i = 0; i < BUY_UNITS.length; i += 1) {
      const unit = BUY_UNITS[i];
      const box = this.buyButtonRect(i);
      const cost = CONFIG[unit.costKey];
      const can = !over && this.player.gold >= cost;
      const lit = hover
        && hover.x >= box.x && hover.x <= box.x + box.w
        && hover.y >= box.y && hover.y <= box.y + box.h;
      const lane = drag && drag.index === i ? drag.lane : null;
      const mid = box.y + box.h / 2;
      ctx.globalAlpha = can ? 1 : 0.45;
      ctx.fillStyle = unit.fill;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      if (lane) {
        ctx.fillStyle = "rgba(255,255,255,0.22)";
        ctx.fillRect(box.x, lane === "top" ? box.y : mid, box.w, box.h / 2);
      }
      ctx.strokeStyle = can && (lit || lane) ? "#ffffff" : unit.stroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      const cx = box.x + box.w / 2;
      ctx.fillStyle = lane === "top" ? "#ffffff" : "#9ee8c8";
      fillChevron(ctx, cx, box.y + box.h * 0.16, true);
      ctx.fillStyle = lane === "bottom" ? "#ffffff" : "#e8c36a";
      fillChevron(ctx, cx, box.y + box.h * 0.84, false);
      ctx.fillStyle = CONFIG.colors.text;
      ctx.font = this.uiFont(13);
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(unit.label, box.x + 6 * CONFIG.uiScale, mid);
      ctx.fillStyle = CONFIG.colors.gold;
      ctx.textAlign = "right";
      ctx.fillText(`${cost}💰`, box.x + box.w - 6 * CONFIG.uiScale, mid);
      ctx.globalAlpha = 1;
    }
  },
};

function unitTypeLabel(type) {
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
function lineSize(troop, allies) {
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
  return group.length;
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

function hasChargeSpeed(troop, board) {
  if (troop.order !== "charge") return false;
  if (troop.type === "cannon" || troop.type === "dragoon") return false;
  const enemies = board.enemy ? board.enemy.troops : [];
  for (let i = 0; i < enemies.length; i += 1) {
    const foe = enemies[i];
    if (foe.hp <= 0) continue;
    if (distance(foe, troop) <= CONFIG.chargeSpeedRange) return true;
  }
  return false;
}

function multText(n) {
  const rounded = Math.round(n * 100) / 100;
  return `×${rounded}`;
}

/** Bonuses that currently change this unit's damage, speed, or armor. */
function activeBonuses(board, troop, allies) {
  const labels = [];
  const mates = lineSize(troop, allies) - 1;
  if (troop.type === "melee" && mates > 0) {
    labels.push(`Line +${Math.round(mates * CONFIG.lineDamageBonus * 100)}%`);
  }
  if (troop.order === "charge") {
    labels.push(`Charge ${multText(CONFIG.doubleDamageMultiplier)}`);
  }
  if (hasChargeSpeed(troop, board)) {
    labels.push(`Speed ${multText(CONFIG.chargeSpeedFactor)}`);
  }
  const enemies = board.enemy ? board.enemy.troops : [];
  let flanking = false;
  for (let i = 0; i < enemies.length; i += 1) {
    if (isFlanking(troop, enemies[i])) {
      flanking = true;
      break;
    }
  }
  if (flanking) {
    let flank = CONFIG.doubleDamageMultiplier;
    if (troop.type === "dragoon") flank *= CONFIG.dragoonFlankBonus;
    labels.push(`Flank ${multText(flank)}`);
  }
  if (touchesQuarterLine(troop)) {
    labels.push(`Cover +${Math.round(CONFIG.quarterArmor * 100)}%`);
  }
  if (troop.type === "dragoon") labels.push(`Speed ${multText(CONFIG.dragoonOpenSpeed)}`);
  return labels.join("   ");
}

function orderAnnouncement(troop, action) {
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

function makeTroop(data, side, mx) {
  const troop = Object.create(viewTroopMethods);
  troop.id = data.id;
  troop.lane = data.lane;
  troop.sublane = data.sublane;
  troop.type = data.type;
  troop.hp = data.hp;
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
    orderCallout: null,
    inspectedId: null,
    hover: null,
    winner: null,
    winReason: null,
    elapsed: 0,
    status: "waiting",
    countdownEnds: null,
    cssScale: 1,
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
