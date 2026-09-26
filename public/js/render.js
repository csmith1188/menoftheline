import { CONFIG } from "../shared/config.js";
import { BUY_UNITS, UNIT_LABELS, UNIT_STATS, UNIT_VARIANTS, unitStats, unitLandCost } from "../shared/units.js";
import { Path, quarterSegments, quarterThickness } from "../shared/path.js";
import {
  applySnapshot,
  boardStateMethods,
  createBoardState,
  inspectReadout,
  readSouthpaw,
  sideStateMethods,
  townStateMethods,
  troopStateMethods,
  useDrawPrototypes,
  writeSouthpaw,
} from "./board.js";

export { applySnapshot, readSouthpaw, writeSouthpaw };

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
  const num = shown % 1 === 0 ? String(shown) : shown.toFixed(1);
  // const text = splat.kind === "heal" ? `+${num}` : num;
  const text = splat.kind === "heal" ? `+` : num;
  const fill = splat.kind === "melee"
    ? CONFIG.colors.splatMelee
    : splat.kind === "heal"
      ? CONFIG.colors.splatHeal
      : CONFIG.colors.splatShoot;
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
  ...troopStateMethods,

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
  ...townStateMethods,

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

    if (this.owner === "player" && this.producing) {
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

  /** Remaining land to the next rank, just above the circle. */
  drawUpgradeCost(ctx, kind, r) {
    if (!this.board.player || this.owner !== "player") return;
    const maxed = this.board.player.upgrades[kind] >= CONFIG.upgradeMax;
    const remain = Math.ceil(this.board.player.upgradeRemaining(kind));
    const cost = maxed ? "MAX" : `${remain}🌿`;
    const y = this.y - r - 6 * CONFIG.uiScale;
    ctx.save();
    ctx.font = this.board.uiFont(13);
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#0d1218";
    ctx.strokeText(cost, this.x, y);
    ctx.fillStyle = this.producing ? "#ffffff" : CONFIG.colors.gold;
    ctx.fillText(cost, this.x, y);
    ctx.restore();
  }
};

const viewSideMethods = {
  ...sideStateMethods,

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
  ...boardStateMethods,

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
    this.drawUpgradeReadouts(ctx);
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
    this.drawUpgradeReadouts(ctx);
    this.drawBuyButtons(ctx);
    this.drawInspectedUnit(ctx);
    this.drawOrderCallout(ctx);
  },


  /**
   * Type, line size, health, and live bonuses for the selected unit,
   * centered above the buy row until it dies or another unit is selected.
   */
  drawInspectedUnit(ctx) {
    const info = inspectReadout(this);
    if (!info) return;
    const layout = this.buyRowLayout();
    const gap = 6 * CONFIG.uiScale;
    const yBonus = layout.y - gap;
    const yMain = info.bonuses ? yBonus - 18 * CONFIG.uiScale : yBonus;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#0d1218";
    ctx.font = this.uiFont(16);
    ctx.strokeText(info.main, CONFIG.canvasWidth / 2, yMain);
    ctx.fillStyle = CONFIG.colors.text;
    ctx.fillText(info.main, CONFIG.canvasWidth / 2, yMain);
    if (info.bonuses) {
      ctx.font = this.uiFont(13);
      ctx.strokeText(info.bonuses, CONFIG.canvasWidth / 2, yBonus);
      ctx.fillStyle = CONFIG.colors.gold;
      ctx.fillText(info.bonuses, CONFIG.canvasWidth / 2, yBonus);
    }
    ctx.restore();
  },


  /**
   * While zoomed: selected unit on the left, order on the right,
   * pinned to the bottom of the screen.
   */
  drawTelescopeHud(ctx) {
    const info = inspectReadout(this);
    const call = this.orderCallout;
    let callFade = 0;
    if (call) {
      const left = call.until - performance.now();
      if (left <= 0) this.orderCallout = null;
      else callFade = left < 280 ? left / 280 : 1;
    }
    if (!info && !this.orderCallout) return;
    const bottom = CONFIG.canvasHeight - 18 * CONFIG.uiScale;
    const leftX = CONFIG.canvasWidth * 0.28;
    const rightX = CONFIG.canvasWidth * 0.72;
    ctx.save();
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#0d1218";
    if (info) {
      const yMain = info.bonuses ? bottom - 20 * CONFIG.uiScale : bottom;
      ctx.textAlign = "center";
      ctx.font = this.uiFont(16);
      ctx.strokeText(info.main, leftX, yMain);
      ctx.fillStyle = CONFIG.colors.text;
      ctx.fillText(info.main, leftX, yMain);
      if (info.bonuses) {
        ctx.font = this.uiFont(13);
        ctx.strokeText(info.bonuses, leftX, bottom);
        ctx.fillStyle = CONFIG.colors.gold;
        ctx.fillText(info.bonuses, leftX, bottom);
      }
    }
    const flash = this.orderCallout;
    const order = flash
      ? { text: flash.text, color: flash.color, fade: callFade }
      : info
        ? { ...info.order, fade: 1 }
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
    const info = inspectReadout(this);
    const gap = 6 * CONFIG.uiScale;
    let y = layout.y - gap;
    if (info) {
      y -= 14 * CONFIG.uiScale;
      if (info.bonuses) y -= 14 * CONFIG.uiScale;
    }
    y -= 8 * CONFIG.uiScale;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
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
    ctx.fillText(String(Math.round(Math.max(0, this.player.capitalHP))), mid - 28 * CONFIG.uiScale, midY);
    ctx.fillStyle = CONFIG.colors.text;
    ctx.font = this.uiFont(14);
    ctx.fillText("—", mid, midY);
    ctx.fillStyle = CONFIG.colors.enemy;
    ctx.font = this.uiFont(18);
    ctx.fillText(String(Math.round(Math.max(0, this.enemy.capitalHP))), mid + 28 * CONFIG.uiScale, midY);
    ctx.restore();
  },

  drawSideStats(ctx, side, x, midY, align) {
    const gold = Math.floor(side.gold);
    const land = Math.floor(side.land);
    const line1 = `${gold}💰 ${side.goldRateLabel()}   ${land}🌿 ${side.landRateLabel()}`;
    const line2 = side.economyDetail();
    ctx.save();
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = side.id === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
    ctx.font = this.uiFont(12);
    ctx.fillText(line1, x, midY - 8 * CONFIG.uiScale);
    ctx.fillStyle = side.netIncome() < 0 ? "#e85d4c" : CONFIG.colors.gold;
    ctx.font = this.uiFont(11, "normal");
    ctx.fillText(line2, x, midY + 9 * CONFIG.uiScale);
    ctx.restore();
  },

  /** Speed, damage, and armor, pinned to the bottom corners. */
  drawUpgradeReadouts(ctx) {
    if (!this.player || !this.enemy) return;
    const y = CONFIG.canvasHeight - 12 * CONFIG.uiScale;
    const pad = 14 * CONFIG.uiScale;
    ctx.save();
    ctx.textBaseline = "bottom";
    ctx.font = this.uiFont(12);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#0d1218";
    ctx.textAlign = "left";
    ctx.strokeText(this.player.upgradeLabel(), pad, y);
    ctx.fillStyle = CONFIG.colors.player;
    ctx.fillText(this.player.upgradeLabel(), pad, y);
    ctx.textAlign = "right";
    ctx.strokeText(this.enemy.upgradeLabel(), CONFIG.canvasWidth - pad, y);
    ctx.fillStyle = CONFIG.colors.enemy;
    ctx.fillText(this.enemy.upgradeLabel(), CONFIG.canvasWidth - pad, y);
    ctx.restore();
  },

  drawBuyButtons(ctx) {
    const hover = this.hover;
    const over = Boolean(this.winner) || this.status !== "playing";
    const drag = this.buyDrag;
    for (let i = 0; i < BUY_UNITS.length; i += 1) {
      const unit = BUY_UNITS[i];
      const variant = UNIT_VARIANTS[unit.type];
      const spawn = this.selectedBuyUnit(unit.type);
      const stats = unitStats(spawn);
      const box = this.buyButtonRect(i);
      const cost = stats.cost;
      const land = unitLandCost(spawn);
      const can = !over
        && this.player.gold >= cost
        && this.player.land >= land;
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
      if (variant) {
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

      if (spawn !== unit.type && land > 0) {
        const ubox = this.variantLandRect(i);
        if (ubox.h <= 0) continue;
        const canLand = !over && this.player.land >= land;
        ctx.globalAlpha = canLand ? 1 : 0.45;
        ctx.fillStyle = "#2a3340";
        ctx.fillRect(ubox.x, ubox.y, ubox.w, ubox.h);
        ctx.strokeStyle = unit.stroke;
        ctx.lineWidth = 2;
        ctx.strokeRect(ubox.x, ubox.y, ubox.w, ubox.h);
        ctx.fillStyle = CONFIG.colors.gold;
        ctx.font = this.uiFont(10);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${land}🌿`, ubox.x + ubox.w / 2, ubox.y + ubox.h / 2);
        ctx.globalAlpha = 1;
      }
    }
  },
};


const nativeText = new WeakMap();


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


useDrawPrototypes({
  troop: viewTroopMethods,
  town: viewTownMethods,
  side: viewSideMethods,
});

export function createBoard(canvas) {
  const board = createBoardState(canvas);
  board.directOrders = true;
  board.ctx = canvas.getContext("2d");
  Object.setPrototypeOf(board, boardMethods);
  board.fitCanvas();
  if (window.ResizeObserver && canvas.parentElement) {
    const observer = new ResizeObserver(() => board.fitCanvas());
    observer.observe(canvas.parentElement);
  }
  return board;
}
