import { CONFIG } from "../shared/config.js";
import { UNIT_STATS, unitStats, variantBadgeFill } from "../shared/units.js";
import { Path, quarterSegments, quarterThickness } from "../shared/path.js";
import { applySouthpaw, readSouthpaw } from "./render.js";
import { canvasFont, uiFontsReady, whenUiFontsReady } from "./board.js";

/** In-match how-to guide. Diagrams read live values from config.js and units.js. */

function ink(ctx, text, x, y, color, size, align, baseline) {
  ctx.font = canvasFont(size, "normal");
  ctx.textAlign = align || "center";
  ctx.textBaseline = baseline || "middle";
  ctx.lineWidth = Math.max(2, size / 5);
  ctx.strokeStyle = "#0d1218";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color || CONFIG.colors.text;
  ctx.fillText(text, x, y);
}

function inkFit(ctx, text, x, y, color, size, maxWidth) {
  let px = size;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = canvasFont(px, "normal");
  while (px > 10 && maxWidth && ctx.measureText(text).width > maxWidth) {
    px -= 1;
    ctx.font = canvasFont(px, "normal");
  }
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#0d1218";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color || CONFIG.colors.text;
  ctx.fillText(text, x, y);
}

function zoomInk(ctx, frame, text, x, y, color, px, align, baseline) {
  ctx.save();
  ctx.font = canvasFont(px / frame.scale, "normal");
  ctx.textAlign = align || "center";
  ctx.textBaseline = baseline || "middle";
  ctx.lineWidth = 3 / frame.scale;
  ctx.strokeStyle = "#0d1218";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color || CONFIG.colors.text;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function clear(ctx, w, h) {
  ctx.fillStyle = CONFIG.colors.bg;
  ctx.fillRect(0, 0, w, h);
}

function fitWorld(w, h, box, margin) {
  const m = typeof margin === "number"
    ? { t: margin, r: margin, b: margin, l: margin }
    : margin;
  const bw = Math.max(1, box.r - box.l);
  const bh = Math.max(1, box.b - box.t);
  const scale = Math.min((w - m.l - m.r) / bw, (h - m.t - m.b) / bh);
  const ox = m.l + ((w - m.l - m.r) - bw * scale) / 2 - box.l * scale;
  const oy = m.t + ((h - m.t - m.b) - bh * scale) / 2 - box.t * scale;
  return { scale, ox, oy };
}

function withWorld(ctx, dest, box, margin, draw) {
  const frame = fitWorld(dest.w, dest.h, box, margin);
  ctx.save();
  ctx.translate(dest.x + frame.ox, dest.y + frame.oy);
  ctx.scale(frame.scale, frame.scale);
  draw(frame);
  ctx.restore();
  return {
    scale: frame.scale,
    ox: dest.x + frame.ox,
    oy: dest.y + frame.oy,
  };
}

function toScreen(frame, x, y) {
  return { x: frame.ox + x * frame.scale, y: frame.oy + y * frame.scale };
}

function cells(w, h, cols, rows) {
  const gap = 8;
  const cw = (w - gap * (cols + 1)) / cols;
  const ch = (h - gap * (rows + 1)) / rows;
  const out = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      out.push({
        x: gap + col * (cw + gap),
        y: gap + row * (ch + gap),
        w: cw,
        h: ch,
      });
    }
  }
  return out;
}

function around(units, padX, padY) {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (let i = 0; i < units.length; i += 1) {
    l = Math.min(l, units[i].x);
    r = Math.max(r, units[i].x);
    t = Math.min(t, units[i].y);
    b = Math.max(b, units[i].y);
  }
  l -= padX;
  r += padX;
  t -= padY;
  b += padY;
  if (b - t < 96) {
    const mid = (t + b) / 2;
    t = mid - 48;
    b = mid + 48;
  }
  return { l, t, r, b };
}

function unitCost(type) {
  return unitStats(type).cost;
}

function armyShare(units, lane) {
  let player = 0;
  let enemy = 0;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit.lane !== lane || unit.broken) continue;
    const value = unit.progress * unitCost(unit.type);
    if (unit.side === "player") player += value;
    else enemy += value;
  }
  const sum = player + enemy;
  if (sum <= 0) return 0.5;
  return player / sum;
}

function place(side, lane, sublane, progress, type, order) {
  const at = Path.pointAt(Path.waypoints(side, lane, sublane), progress);
  return {
    side,
    lane,
    sublane,
    progress,
    type,
    order: order || null,
    x: at.x,
    y: at.y,
  };
}

function placeX(side, sublane, x, type, order) {
  const span = CONFIG.enemyCapital.x - CONFIG.playerCapital.x;
  const along = (x - CONFIG.playerCapital.x) / span;
  const progress = side === "player" ? along : 1 - along;
  return place(side, "top", sublane, progress, type, order);
}

function orderStroke(order) {
  if (order === "halt") return CONFIG.colors.halt;
  if (order === "reform") return CONFIG.colors.reform;
  if (order === "charge") return CONFIG.colors.charge;
  if (order === "fallback") return CONFIG.colors.fallback;
  if (order === "retreat") return CONFIG.colors.retreat;
  return "#0d1218";
}

function unitTangent(unit) {
  if (!unit.lane) return { x: unit.side === "enemy" ? -1 : 1, y: 0 };
  const points = Path.waypoints(unit.side, unit.lane, unit.sublane || 0);
  return Path.tangentAt(points, unit.progress || 0);
}

function drawUnit(ctx, unit) {
  const color = unit.side === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
  const ordered = unit.order === "reform" || unit.order === "halt"
    || unit.order === "charge" || unit.order === "fallback" || unit.order === "retreat";
  ctx.fillStyle = color;
  ctx.strokeStyle = orderStroke(unit.order);
  ctx.lineWidth = ordered ? 3 : 2;
  const x = unit.x;
  const y = unit.y;
  const stats = unitStats(unit.variant || unit.type);
  const r = stats.radius;

  const badge = variantBadgeFill(unit.variant || unit.type);
  if (badge) {
    const pad = r + 3;
    ctx.fillStyle = badge;
    ctx.fillRect(x - pad, y - pad, pad * 2, pad * 2);
  }
  ctx.fillStyle = color;
  if (unit.type === "cannon") {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (unit.type === "skirmisher") {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.lineTo(x - r, y + r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (unit.type === "dragoon") {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (unit.type === "officer") {
    const s = r * 0.75;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = ordered ? 5 : 4;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s);
    ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s);
    ctx.lineTo(x - s, y + s);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = ordered ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s);
    ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s);
    ctx.lineTo(x - s, y + s);
    ctx.stroke();
    ctx.restore();
  } else {
    const tan = unitTangent(unit);
    const len = r * 0.6;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = ordered ? 12 : 10;
    ctx.beginPath();
    ctx.moveTo(x - tan.y * len, y + tan.x * len);
    ctx.lineTo(x + tan.y * len, y - tan.x * len);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = ordered ? 8 : 6;
    ctx.stroke();
    ctx.restore();
  }

  const maxHp = stats.hp;
  const ratio = unit.hp == null ? 1 : Math.max(0, unit.hp) / maxHp;
  const barW = r * 2;
  ctx.fillStyle = "#1a1510";
  ctx.fillRect(x - barW / 2, y - 1.5, barW, 3);
  ctx.fillStyle = CONFIG.colors.gold;
  ctx.fillRect(x - barW / 2, y - 1.5, barW * ratio, 3);
  const maxFatigue = stats.fatigue || 100;
  const fatRatio = unit.fatigue == null ? 0 : Math.max(0, unit.fatigue) / maxFatigue;
  ctx.fillStyle = "#1a1510";
  ctx.fillRect(x - barW / 2, y + 2.5, barW, 3);
  ctx.fillStyle = CONFIG.colors.fatigue;
  ctx.fillRect(x - barW / 2, y + 2.5, barW * fatRatio, 3);
}

function drawShot(ctx, x, y) {
  const shell = UNIT_STATS.troop;
  ctx.beginPath();
  ctx.arc(x, y, shell.projectileSize, 0, Math.PI * 2);
  ctx.fillStyle = shell.projectileColor;
  ctx.fill();
}

function drawKeep(ctx, side) {
  const cap = side === "player" ? CONFIG.playerCapital : CONFIG.enemyCapital;
  const color = side === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
  const dark = side === "player" ? CONFIG.colors.playerDark : CONFIG.colors.enemyDark;
  ctx.beginPath();
  ctx.arc(cap.x, cap.y, CONFIG.capitalRadius, 0, Math.PI * 2);
  ctx.fillStyle = dark;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cap.x, cap.y, 12, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawGround(ctx) {
  const left = CONFIG.playerCapital;
  const right = CONFIG.enemyCapital;
  ctx.fillStyle = CONFIG.colors.topLane;
  ctx.fillRect(
    left.x,
    left.y - CONFIG.topLaneHeight / 2,
    right.x - left.x,
    CONFIG.topLaneHeight,
  );

  ctx.save();
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
  ctx.restore();

  const segs = quarterSegments();
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = quarterThickness();
  ctx.globalAlpha = 0.55;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    ctx.strokeStyle = seg.color;
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
  }
  ctx.restore();
}

function upgradeKind(index) {
  const last = CONFIG.checkpointCount - 1;
  const dist = Math.min(index, last - index);
  if (dist === 0) return "armor";
  if (dist === 1) return "speed";
  return "damage";
}

function townSpots() {
  const center = Path.bottomCenter();
  const innerEdge = Path.bottomRadius(CONFIG.bottomSublaneCount - 1) - CONFIG.bottomSublaneWidth / 2;
  const townR = CONFIG.checkpointRadius * CONFIG.uiScale;
  const radius = innerEdge - townR + CONFIG.checkpointLaneOverlap;
  const spots = [];
  for (let i = 0; i < CONFIG.checkpointCount; i += 1) {
    const t = (i + 1) / (CONFIG.checkpointCount + 1);
    const theta = Math.PI * (1 - t);
    spots.push({
      x: center.x + radius * Math.cos(theta),
      y: center.y + radius * Math.sin(theta),
      r: townR,
      kind: upgradeKind(i),
    });
  }
  return spots;
}

function drawKindGlyph(ctx, x, y, r, kind, ink) {
  const color = ink || "#0d1218";
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.6, r * 0.22);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (kind === "speed") {
    ctx.beginPath();
    ctx.moveTo(x - r * 0.12, y - r * 0.55);
    ctx.lineTo(x + r * 0.28, y - r * 0.02);
    ctx.lineTo(x + r * 0.02, y - r * 0.02);
    ctx.lineTo(x + r * 0.18, y + r * 0.55);
    ctx.lineTo(x - r * 0.28, y + r * 0.02);
    ctx.lineTo(x - r * 0.02, y + r * 0.02);
    ctx.closePath();
    ctx.fill();
  } else if (kind === "armor") {
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.52);
    ctx.lineTo(x + r * 0.42, y - r * 0.22);
    ctx.lineTo(x + r * 0.42, y + r * 0.08);
    ctx.lineTo(x, y + r * 0.52);
    ctx.lineTo(x - r * 0.42, y + r * 0.08);
    ctx.lineTo(x - r * 0.42, y - r * 0.22);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.28);
    ctx.lineTo(x, y + r * 0.22);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(x - r * 0.4, y - r * 0.42);
    ctx.lineTo(x + r * 0.4, y + r * 0.42);
    ctx.moveTo(x + r * 0.4, y - r * 0.42);
    ctx.lineTo(x - r * 0.4, y + r * 0.42);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTownMarker(ctx, spot, owner, ring) {
  const color = owner === "player"
    ? CONFIG.colors.player
    : owner === "enemy"
      ? CONFIG.colors.enemy
      : CONFIG.colors.neutral;
  ctx.beginPath();
  ctx.arc(spot.x, spot.y, spot.r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#0d1218";
  ctx.stroke();
  if (ring) {
    ctx.beginPath();
    ctx.arc(spot.x, spot.y, spot.r + 5, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  drawKindGlyph(ctx, spot.x, spot.y, spot.r * 0.7, spot.kind);
}

function drawLaneMarks(ctx, frame, topT, bottomT) {
  const left = CONFIG.playerCapital;
  const right = CONFIG.enemyCapital;
  const x = left.x + (right.x - left.x) * topT;
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
  zoomInk(
    ctx,
    frame,
    `${Math.round(CONFIG.centerIncome * topT)}🪙`,
    x,
    top - 6,
    CONFIG.colors.player,
    14,
    "center",
    "bottom",
  );

  const c = Path.bottomCenter();
  const theta = Math.PI * (1 - bottomT);
  const rIn = Path.bottomRadius(CONFIG.bottomSublaneCount - 1) - 10;
  const rOut = Path.bottomRadius(0) + 10;
  ctx.save();
  ctx.strokeStyle = CONFIG.colors.laneCenter;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(c.x + rIn * Math.cos(theta), c.y + rIn * Math.sin(theta));
  ctx.lineTo(c.x + rOut * Math.cos(theta), c.y + rOut * Math.sin(theta));
  ctx.stroke();
  ctx.restore();
  const landR = rIn + (rOut - rIn) * 0.72;
  zoomInk(
    ctx,
    frame,
    `${Math.round(CONFIG.centerLand * bottomT)}🌿`,
    c.x + landR * Math.cos(theta),
    c.y + landR * Math.sin(theta),
    CONFIG.colors.player,
    14,
  );
}

function worldArrow(ctx, x1, y1, x2, y2, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = 10;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(ang - 0.5), y2 - head * Math.sin(ang - 0.5));
  ctx.lineTo(x2 - head * Math.cos(ang + 0.5), y2 - head * Math.sin(ang + 0.5));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function vignette(ctx, rect, box, label, draw) {
  const mapH = Math.max(1, rect.h - 24);
  ctx.fillStyle = CONFIG.colors.bg;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, mapH);
  ctx.clip();
  withWorld(ctx, { x: rect.x, y: rect.y, w: rect.w, h: mapH }, box, 6, draw);
  ctx.restore();
  ctx.strokeStyle = "#314257";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  inkFit(ctx, label, rect.x + rect.w / 2, rect.y + rect.h - 12, CONFIG.colors.text, 13, rect.w - 10);
}

function drawKeeps(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 1);
  const foe = placeX("enemy", 2, 200, "troop");
  const friend = placeX("player", 2, 790, "troop");
  vignette(ctx, panels[0], { l: 24, t: 90, r: 250, b: 220 }, "Your keep fires", (frame) => {
    drawGround(ctx);
    drawKeep(ctx, "player");
    drawUnit(ctx, foe);
    drawShot(ctx, (CONFIG.playerCapital.x + foe.x) / 2, foe.y - 16);
    zoomInk(ctx, frame, String(CONFIG.capitalHP), CONFIG.playerCapital.x, CONFIG.playerCapital.y + 52, CONFIG.colors.player, 16);
  });
  vignette(ctx, panels[1], { l: 710, t: 90, r: 936, b: 220 }, "Strike their keep", (frame) => {
    drawGround(ctx);
    drawKeep(ctx, "enemy");
    drawUnit(ctx, friend);
    drawShot(ctx, (friend.x + CONFIG.enemyCapital.x) / 2, friend.y - 16);
    zoomInk(ctx, frame, String(CONFIG.capitalHP), CONFIG.enemyCapital.x, CONFIG.enemyCapital.y + 52, CONFIG.colors.enemy, 16);
  });
}

function drawLanes(ctx, w, h) {
  clear(ctx, w, h);
  const units = [
    place("player", "top", 2, 0.7, "troop"),
    place("player", "top", 0, 0.45, "skirmisher"),
    place("enemy", "top", 4, 0.2, "cannon"),
    place("player", "bottom", 1, 0.3, "troop"),
    place("enemy", "bottom", 0, 0.62, "dragoon"),
  ];
  const owners = ["player", "player", null, "enemy", "enemy"];
  const frame = withWorld(ctx, { x: 0, y: 0, w, h }, { l: 36, t: 58, r: 924, b: 604 }, 10, (world) => {
    drawGround(ctx);
    drawLaneMarks(ctx, world, armyShare(units, "top"), armyShare(units, "bottom"));
    const spots = townSpots();
    for (let i = 0; i < spots.length; i += 1) {
      drawTownMarker(ctx, spots[i], owners[i], false);
    }
    drawKeep(ctx, "player");
    drawKeep(ctx, "enemy");
    for (let i = 0; i < units.length; i += 1) drawUnit(ctx, units[i]);
  });
  const cover = quarterSegments()[0];
  const at = toScreen(frame, cover.x1, (cover.y1 + cover.y2) / 2);
  ink(ctx, "fort", Math.max(36, at.x - 8), at.y, CONFIG.colors.player, 12, "right");
  const hillPaces = CONFIG.topLanePaces / 3;
  const hillT = hillPaces / CONFIG.topLanePaces;
  const hillPt = Path.pointAt(Path.worldPoints("top", 0), hillT);
  const hillAt = toScreen(frame, hillPt.x, hillPt.y);
  ink(ctx, "terrain ⛰️", hillAt.x, Math.max(14, hillAt.y - 16), CONFIG.colors.text, 11);
  const town = townSpots()[2];
  const townAt = toScreen(frame, town.x, town.y);
  ink(ctx, "towns", townAt.x, Math.min(h - 12, townAt.y + 22), CONFIG.colors.text, 12);
}

/** Short in-match controls guide (settings menu). */
function drawHowtoButtons(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 2);

  vignette(ctx, panels[0], { l: 40, t: 100, r: 220, b: 220 }, "Click banks to buy", (frame) => {
    drawGround(ctx);
    drawKeep(ctx, "player");
    const cap = CONFIG.playerCapital;
    const size = 18;
    const gap = 6;
    const count = CONFIG.bankCount;
    const total = count * size + (count - 1) * gap;
    const startX = cap.x - total / 2;
    const y = cap.y - CONFIG.capitalRadius - size - 8;
    for (let i = 0; i < count; i += 1) {
      const x = startX + i * (size + gap);
      ctx.fillStyle = i < 1 ? CONFIG.colors.gold : "#2a3648";
      ctx.fillRect(x, y, size, size);
      ctx.strokeStyle = "#0d1218";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, size, size);
    }
    worldArrow(ctx, startX + size * 1.5 + gap, y - 28, startX + size * 1.5 + gap, y - 4, CONFIG.colors.gold);
    zoomInk(ctx, frame, "🏛️", startX + size * 1.5 + gap, y + size / 2, CONFIG.colors.text, 12);
  });

  vignette(ctx, panels[1], { l: 430, t: 120, r: 560, b: 220 }, "Swipe unit · up/down lane", () => {
    drawGround(ctx);
    const bx = 495;
    const by = 170;
    const bw = 44;
    const bh = 36;
    ctx.fillStyle = "#243246";
    ctx.fillRect(bx - bw / 2, by - bh / 2, bw, bh);
    ctx.strokeStyle = CONFIG.colors.player;
    ctx.lineWidth = 2;
    ctx.strokeRect(bx - bw / 2, by - bh / 2, bw, bh);
    drawUnit(ctx, { x: bx, y: by, side: "player", type: "troop" });
    worldArrow(ctx, bx, by - bh / 2 - 6, bx, by - bh / 2 - 28, CONFIG.colors.laneHover);
    worldArrow(ctx, bx, by + bh / 2 + 6, bx, by + bh / 2 + 28, CONFIG.colors.gold);
  });

  vignette(ctx, panels[2], { l: 430, t: 120, r: 560, b: 220 }, "Swipe unit · cycle types", () => {
    drawGround(ctx);
    const bx = 495;
    const by = 170;
    const bw = 44;
    const bh = 36;
    ctx.fillStyle = "#243246";
    ctx.fillRect(bx - bw / 2, by - bh / 2, bw, bh);
    ctx.strokeStyle = CONFIG.colors.whiteAlternate;
    ctx.lineWidth = 2;
    ctx.strokeRect(bx - bw / 2, by - bh / 2, bw, bh);
    drawUnit(ctx, { x: bx, y: by, side: "player", type: "troop", variant: "militia", alternate: true });
    worldArrow(ctx, bx - bw / 2 - 6, by, bx - bw / 2 - 28, by, CONFIG.colors.gold);
    worldArrow(ctx, bx + bw / 2 + 6, by, bx + bw / 2 + 28, by, CONFIG.colors.gold);
  });

  const town = townSpots()[2];
  vignette(ctx, panels[3], around([
    { x: town.x, y: town.y },
    place("player", "bottom", 1, 0.45, "troop"),
  ], 70, 50), "Click town · research", () => {
    drawGround(ctx);
    drawTownMarker(ctx, town, "player", true);
    drawUnit(ctx, place("player", "bottom", 1, 0.45, "troop"));
  });
}

function drawHowtoMap(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 2);
  const sample = [
    place("player", "top", 2, 0.55, "troop"),
    place("enemy", "top", 3, 0.35, "troop"),
    place("player", "bottom", 1, 0.4, "dragoon"),
  ];

  vignette(ctx, panels[0], { l: 280, t: 100, r: 680, b: 220 }, "Click / pinch / wheel · zoom lane", () => {
    drawGround(ctx);
    drawKeep(ctx, "player");
    drawKeep(ctx, "enemy");
    for (let i = 0; i < sample.length; i += 1) {
      if (sample[i].lane === "top") drawUnit(ctx, sample[i]);
    }
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(360, 110, 240, 90);
    ctx.restore();
  });

  vignette(ctx, panels[1], { l: 200, t: 80, r: 760, b: 520 }, "Swipe up/down · switch lanes", (frame) => {
    drawGround(ctx);
    drawKeep(ctx, "player");
    drawKeep(ctx, "enemy");
    for (let i = 0; i < sample.length; i += 1) drawUnit(ctx, sample[i]);
    const midX = (CONFIG.playerCapital.x + CONFIG.enemyCapital.x) / 2;
    worldArrow(ctx, midX, 200, midX, 280, CONFIG.colors.laneHover);
    worldArrow(ctx, midX, 360, midX, 280, CONFIG.colors.laneHover);
    zoomInk(ctx, frame, "lanes", midX + 36, 290, CONFIG.colors.text, 13, "left");
  });

  vignette(ctx, panels[2], { l: 300, t: 110, r: 660, b: 210 }, "Swipe left/right · traverse", () => {
    drawGround(ctx);
    const u = place("player", "top", 2, 0.5, "troop");
    drawUnit(ctx, u);
    worldArrow(ctx, u.x - 20, u.y - 36, u.x - 70, u.y - 36, CONFIG.colors.gold);
    worldArrow(ctx, u.x + 20, u.y - 36, u.x + 70, u.y - 36, CONFIG.colors.gold);
  });

  vignette(ctx, panels[3], { l: 36, t: 58, r: 924, b: 604 }, "Field / pinch / wheel · zoom out", () => {
    drawGround(ctx);
    drawKeep(ctx, "player");
    drawKeep(ctx, "enemy");
    for (let i = 0; i < sample.length; i += 1) drawUnit(ctx, sample[i]);
    const spots = townSpots();
    for (let i = 0; i < spots.length; i += 1) {
      drawTownMarker(ctx, spots[i], i < 2 ? "player" : null, false);
    }
  });
}

function drawHowtoUnits(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 2);

  const line = [1, 2, 3].map((row) => place("player", "top", row, 0.5, "troop", "halt"));
  vignette(ctx, panels[0], around(line, 56, 28), "Click line · Halt, then Advance", () => {
    drawGround(ctx);
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(line[1].x, line[1].y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    for (let i = 0; i < line.length; i += 1) drawUnit(ctx, line[i]);
  });

  const switcher = placeX("player", 2, 500, "troop");
  const mate = placeX("player", 1, 500, "troop");
  vignette(ctx, panels[1], around([switcher, mate], 70, 40), "Swipe up/down · row / Reform", () => {
    drawGround(ctx);
    drawUnit(ctx, mate);
    drawUnit(ctx, switcher);
    worldArrow(ctx, switcher.x, switcher.y - 18, switcher.x, mate.y + 14, CONFIG.colors.reform);
    worldArrow(ctx, switcher.x + 36, switcher.y + 18, switcher.x + 36, switcher.y + 52, CONFIG.colors.laneHover);
  });

  const charger = placeX("player", 2, 470, "troop", "charge");
  const chargeFoe = placeX("enemy", 2, 560, "troop");
  vignette(ctx, panels[2], around([charger, chargeFoe], 70, 36), "Swipe forward/back · charge / fall back", () => {
    drawGround(ctx);
    worldArrow(ctx, charger.x - 36, charger.y - 28, chargeFoe.x - 16, charger.y - 28, CONFIG.colors.charge);
    drawUnit(ctx, charger);
    drawUnit(ctx, chargeFoe);
  });

  const halted = placeX("player", 1, 520, "troop", "halt");
  const walker = placeX("player", 2, 470, "troop");
  vignette(ctx, panels[3], around([halted, walker], 70, 40), "Walk into Perfect Line · order passing", (frame) => {
    drawGround(ctx);
    drawUnit(ctx, halted);
    drawUnit(ctx, walker);
    worldArrow(ctx, walker.x + 10, walker.y, halted.x - 14, walker.y, CONFIG.colors.halt);
    zoomInk(ctx, frame, "Halt", halted.x, halted.y - 28, CONFIG.colors.halt, 12);
  });
}

function drawHowtoPushback(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 1);

  const shooter = placeX("player", 2, 430, "skirmisher");
  const target = placeX("enemy", 2, 560, "troop");
  vignette(ctx, panels[0], around([shooter, target], 80, 40), "Hit · push back one pace", (frame) => {
    drawGround(ctx);
    drawUnit(ctx, shooter);
    drawUnit(ctx, target);
    drawShot(ctx, (shooter.x + target.x) / 2, shooter.y - 14);
    worldArrow(ctx, target.x + 8, target.y + 28, target.x + 70, target.y + 28, CONFIG.colors.enemy);
    zoomInk(ctx, frame, "push", target.x + 40, target.y + 48, CONFIG.colors.enemy, 12);
  });

  const blocked = placeX("enemy", 2, 520, "troop");
  const rear = placeX("enemy", 2, 600, "troop");
  vignette(ctx, panels[1], around([blocked, rear], 80, 40), "Blocked · fatigue instead", (frame) => {
    drawGround(ctx);
    drawUnit(ctx, blocked);
    drawUnit(ctx, rear);
    worldArrow(ctx, blocked.x + 10, blocked.y - 30, blocked.x + 55, blocked.y - 30, "#8aa0b8");
    zoomInk(ctx, frame, `+${CONFIG.fatiguePerPace} fatigue`, blocked.x + 32, blocked.y - 48, CONFIG.colors.fatigue, 12);
  });
}

function drawHowtoRestore(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 1);

  const hurt = placeX("player", 2, 420, "troop", "halt");
  hurt.hp = unitStats("troop").hp * 0.5;
  hurt.fatigue = 40;
  const foe = placeX("enemy", 2, 560, "troop");
  vignette(ctx, panels[0], around([hurt, foe], 90, 50), "Half health · −25% damage", (frame) => {
    drawGround(ctx);
    drawUnit(ctx, hurt);
    drawUnit(ctx, foe);
    drawShot(ctx, (hurt.x + foe.x) / 2, hurt.y - 12);
    zoomInk(ctx, frame, "−25%", (hurt.x + foe.x) / 2, hurt.y - 36, CONFIG.colors.splatMelee, 12);
    zoomInk(ctx, frame, "+", hurt.x, hurt.y - 40, CONFIG.colors.splatFatigue, 16);
  });

  const guard = placeX("player", 2, 400, "officer");
  guard.variant = "colorGuard";
  guard.alternate = true;
  const rallied = placeX("player", 2, 480, "troop", "halt");
  rallied.hp = unitStats("troop").hp * 0.5;
  const target = placeX("enemy", 2, 600, "troop");
  vignette(ctx, panels[1], around([guard, rallied, target], 100, 50), "Color Guard · full damage", (frame) => {
    drawGround(ctx);
    drawUnit(ctx, guard);
    drawUnit(ctx, rallied);
    drawUnit(ctx, target);
    drawShot(ctx, (rallied.x + target.x) / 2, rallied.y - 12);
    zoomInk(ctx, frame, "full", (rallied.x + target.x) / 2, rallied.y - 36, CONFIG.colors.gold, 12);
    zoomInk(ctx, frame, "+", rallied.x - 10, rallied.y - 40, CONFIG.colors.splatHeal, 16);
    zoomInk(ctx, frame, "+", rallied.x + 12, rallied.y - 40, CONFIG.colors.splatFatigue, 16);
  });
}

function drawHowtoSkirmishers(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 1);

  const skirm = placeX("player", 2, 420, "skirmisher");
  const horse = placeX("enemy", 2, 520, "dragoon");
  const nearTroop = placeX("enemy", 1, 560, "troop");
  vignette(ctx, panels[0], around([skirm, horse, nearTroop], 90, 50), "Priority · cavalry if closest", (frame) => {
    drawGround(ctx);
    drawUnit(ctx, nearTroop);
    drawUnit(ctx, horse);
    drawUnit(ctx, skirm);
    drawShot(ctx, (skirm.x + horse.x) / 2, skirm.y - 12);
    worldArrow(ctx, skirm.x + 12, skirm.y - 22, horse.x - 10, horse.y - 18, CONFIG.colors.gold);
    zoomInk(ctx, frame, "first", horse.x, horse.y - 36, CONFIG.colors.gold, 12);
  });

  const lineTroops = [
    placeX("enemy", 1, 430, "troop"),
    placeX("enemy", 2, 430, "troop"),
    placeX("enemy", 3, 430, "troop"),
  ];
  const light = placeX("player", 2, 560, "skirmisher");
  vignette(ctx, panels[1], around([...lineTroops, light], 90, 50), "Troop line · no bonus vs skirmish", (frame) => {
    drawGround(ctx);
    for (let i = 0; i < lineTroops.length; i += 1) drawUnit(ctx, lineTroops[i]);
    drawUnit(ctx, light);
    drawShot(ctx, (lineTroops[1].x + light.x) / 2, lineTroops[1].y - 12);
    zoomInk(ctx, frame, "no line +", (lineTroops[1].x + light.x) / 2, lineTroops[1].y - 36, CONFIG.colors.gold, 12);
  });
}

const howtoPages = [
  {
    title: "Main Objective",
    artHeight: 230,
    blocks: [
      {
        kind: "ul",
        items: [
          "Build units to attack the enemy Capital.",
        ],
      },
    ],
    draw: drawKeeps,
  },
  {
    title: "Secondary Objectives",
    aspect: 1.45,
    blocks: [
      {
        kind: "ul",
        items: [
          "Push the line in the top lane to gain more gold and build more units.",
          "Push the line in the bottom lane to gain more land and build better units and upgrades.",
          "Friendly units in a fort footprint have 20% cover against attackers outside it. Enemies move at half speed through the colored fort band.",
          "Woods, peaks, and hills grant cover (+10%, +30%, and +20%) only against attackers outside that same footprint.",
        ],
      },
    ],
    draw: drawLanes,
  },
  {
    title: "Button Controls",
    artHeight: 320,
    blocks: [
      {
        kind: "ul",
        items: [
          "Click Banks to buy them.",
          "Swipe Unit Buttons up/down to purchase for the top/bottom lane.",
          "Swipe Unit Buttons left/right to cycle the unit type (base, yellow elite, white light).",
          "Click a Town you control to enable/disable researching in that town.",
        ],
      },
    ],
    draw: drawHowtoButtons,
  },
  {
    title: "Map Controls",
    artHeight: 320,
    blocks: [
      {
        kind: "ul",
        items: [
          "Click an empty part of lane, pinch zoom in, or mouse wheel up to zoom into that lane.",
          "Swipe up/down to switch lanes when zoomed.",
          "Swipe left/right on an empty part of the lane to traverse the lane.",
          "Click the green field, pinch zoom out, or mouse wheel down to return to regular view.",
        ],
      },
    ],
    draw: drawHowtoMap,
  },
  {
    title: "Unit Controls",
    artHeight: 320,
    blocks: [
      {
        kind: "ul",
        items: [
          "Actions done to one unit apply to all matching units in a line.",
          "Click a unit to Halt. Click a Halted unit to Advance.",
          "Swipe up or down to move the line one row. Switching onto a matching unit in line Reforms.",
          "Swipe forward to Charge.",
          "Swipe back to Fall Back.",
          "Long press or right-click a single unit to issue orders to only that unit (ignore lines).",
          "Troops only: an Advancing Troop that newly walks into Perfect Line with a Halted or Reforming Troop on an adjacent row takes that order on itself alone. A long-press (solo) Advance while already In Line behind them does not re-inherit at Perfect Line (you can walk past). Reform movement does not trigger it.",
        ],
      },
    ],
    draw: drawHowtoUnits,
  },
  {
    title: "Skirmishers & Rifles",
    artHeight: 230,
    blocks: [
      {
        kind: "ul",
        items: [
          "Full reload whenever firing is allowed, including Fall Back.",
          "Shoot by priority: cavalry if closest, then Skirmishers/Rifles, Officers, artillery, other cavalry, then Troops.",
          "Among same-priority targets In Line across rows, aim at the nearer row (then closer). The keep counts as your row.",
          "Troop line bonus stacks per eligible mate, then scales with how Perfect you are with adjacent-row neighbors (full in Perfect Line, nearly none at the In Line edge).",
          "Troop line bonus does not apply when shooting Skirmishers or Rifles.",
          "Rifles deal double damage to Officers. Skirmishers have stronger shooting pushback.",
          "Guerillas Halted in the open only shoot enemies within stealth range; occupying terrain lets them Halt-shoot at full range.",
        ],
      },
    ],
    draw: drawHowtoSkirmishers,
  },
  {
    title: "Wounds & Restore",
    artHeight: 230,
    blocks: [
      {
        kind: "ul",
        items: [
          "Missing health cuts damage at half that fraction (50% health → 25% less damage).",
          "Officers and Color Guards each restore fatigue and health nearby (doubled when ahead).",
          "Color Guard aura negates missing-health damage loss for friends.",
          "Blue + while Halt recovers fatigue. Green + while health is restored from Officers, Color Guards, or keeps.",
          "One restore source: + at quarter rate. Two: alternate at half rate. Three or more: alternate at full rate.",
        ],
      },
    ],
    draw: drawHowtoRestore,
  },
  {
    title: "Pushback",
    artHeight: 230,
    blocks: [
      {
        kind: "ul",
        items: [
          `Hits add pushback. Every ${CONFIG.pushbackPerPace} pushback forces one pace toward your keep.`,
          "Shooting always applies the shooter's shooting pushback. Melee pushback only from a Charge.",
          `If a friendly blocks the pace back, that pace is still spent and adds ${CONFIG.fatiguePerPace} fatigue (guns skip fatigue on recoil).`,
          "Units already moving back (Retreat, Fall Back, charge reverse, peel) ignore pushback.",
          "Guns recoil themselves when they fire. The Keep gun pushes units but never recoils or gets pushed.",
          "Grenadiers take half of all incoming pushback.",
          "Stacked paces apply one instant step per tick.",
        ],
      },
    ],
    draw: drawHowtoPushback,
  },
];

function fillCopy(copy, blocks) {
  copy.replaceChildren();
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.kind === "p") {
      const p = document.createElement("p");
      p.textContent = block.text;
      copy.appendChild(p);
    } else {
      const ul = document.createElement("ul");
      for (let n = 0; n < block.items.length; n += 1) {
        const li = document.createElement("li");
        li.textContent = block.items[n];
        ul.appendChild(li);
      }
      copy.appendChild(ul);
    }
  }
}

export function bindRules(options) {
  const onOpen = options && options.onOpen;
  const openBtn = document.getElementById("howto");
  const overlay = document.getElementById("rules");
  const title = document.getElementById("rules-title");
  const art = document.getElementById("rules-art");
  const copy = document.getElementById("rules-copy");
  const prev = document.getElementById("rules-prev");
  const next = document.getElementById("rules-next");
  const dots = document.getElementById("rules-dots");
  const pageLabel = document.getElementById("rules-page");
  const close = document.getElementById("rules-close");
  let index = 0;

  function sizeArt() {
    const page = howtoPages[index];
    const w = art.clientWidth || overlay.clientWidth || 640;
    const h = page.aspect
      ? Math.round(Math.max(200, Math.min(460, w / page.aspect)))
      : page.artHeight;
    art.style.height = `${h}px`;
  }

  function paint() {
    sizeArt();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = art.clientWidth;
    const h = art.clientHeight;
    if (w < 2 || h < 2) return;
    art.width = Math.round(w * dpr);
    art.height = Math.round(h * dpr);
    const ctx = art.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    applySouthpaw(ctx, w, readSouthpaw());
    howtoPages[index].draw(ctx, w, h);
    if (!uiFontsReady()) {
      whenUiFontsReady(() => {
        if (!overlay.classList.contains("hidden")) paint();
      });
    }
  }

  function render() {
    const page = howtoPages[index];
    title.textContent = page.title;
    fillCopy(copy, page.blocks);
    pageLabel.textContent = `${index + 1} / ${howtoPages.length}`;
    prev.disabled = index === 0;
    next.disabled = index === howtoPages.length - 1;
    dots.replaceChildren();
    for (let i = 0; i < howtoPages.length; i += 1) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "rules-dot";
      dot.setAttribute("aria-label", howtoPages[i].title);
      dot.setAttribute("aria-current", i === index ? "true" : "false");
      dot.addEventListener("click", () => go(i));
      dots.appendChild(dot);
    }
    paint();
  }

  function go(nextIndex) {
    index = Math.max(0, Math.min(howtoPages.length - 1, nextIndex));
    render();
    const card = overlay.querySelector(".rules-card") || overlay;
    card.scrollTop = 0;
  }

  function hide() {
    overlay.classList.add("hidden");
    if (openBtn) openBtn.setAttribute("aria-expanded", "false");
  }

  function show() {
    const wasHidden = overlay.classList.contains("hidden");
    if (wasHidden && onOpen) onOpen();
    overlay.classList.remove("hidden");
    if (openBtn) openBtn.setAttribute("aria-expanded", "true");
    render();
    requestAnimationFrame(paint);
    if (wasHidden) overlay.focus();
  }

  if (openBtn) openBtn.addEventListener("click", show);
  if (close) close.addEventListener("click", hide);
  prev.addEventListener("click", () => go(index - 1));
  next.addEventListener("click", () => go(index + 1));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) hide();
  });
  document.addEventListener("keydown", (event) => {
    if (overlay.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      hide();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(index - 1);
    }
  });
  window.addEventListener("resize", () => {
    if (!overlay.classList.contains("hidden")) paint();
  });

  return {
    close: hide,
    repaint() {
      if (!overlay.classList.contains("hidden")) render();
    },
  };
}
