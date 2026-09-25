import { CONFIG } from "../shared/config.js";
import { BUY_UNITS, UNIT_LABELS, UNIT_STATS, UNIT_VARIANTS, unitStats } from "../shared/units.js";
import { Path, quarterSegments, quarterThickness } from "../shared/path.js";
import { applySouthpaw, readSouthpaw } from "./render.js";

/** Rules booklet. Diagrams read live values from config.js and units.js. */

function ink(ctx, text, x, y, color, size, align, baseline) {
  ctx.font = `${size}px Trebuchet MS, Segoe UI, sans-serif`;
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
  ctx.font = `${px}px Trebuchet MS, Segoe UI, sans-serif`;
  while (px > 10 && maxWidth && ctx.measureText(text).width > maxWidth) {
    px -= 1;
    ctx.font = `${px}px Trebuchet MS, Segoe UI, sans-serif`;
  }
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#0d1218";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color || CONFIG.colors.text;
  ctx.fillText(text, x, y);
}

function zoomInk(ctx, frame, text, x, y, color, px, align, baseline) {
  ctx.save();
  ctx.font = `${px / frame.scale}px Trebuchet MS, Segoe UI, sans-serif`;
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

function rangedHit(from, to, type) {
  const stats = unitStats(type);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const falloff = Math.max(CONFIG.minDamageFactor, 1 - dist / Math.max(stats.range, 1));
  return Math.round(stats.rangedDamage * falloff);
}

function meleeHit(type, flags) {
  const stats = unitStats(type);
  let damage = stats.meleeDamage;
  if (flags.charge) damage *= stats.chargeMultiplier;
  if (flags.flank) damage *= stats.flankMultiplier;
  if (stats.lineBonus) {
    damage *= 1 + (flags.lineMates || 0) * stats.lineBonus;
  }
  return Math.round(damage);
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

  if (unit.alternate) {
    const pad = r + 3;
    ctx.fillStyle = "#ffffff";
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

function drawSplat(ctx, x, y, amount, kind) {
  const text = String(Math.round(amount));
  ctx.save();
  ctx.font = "bold 14px Trebuchet MS, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = CONFIG.colors.splatStroke;
  ctx.strokeText(text, x, y - 18);
  ctx.fillStyle = kind === "melee" ? CONFIG.colors.splatMelee : CONFIG.colors.splatShoot;
  ctx.fillText(text, x, y - 18);
  ctx.restore();
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
  if (dist === 0) return "speed";
  if (dist === 1) return "armor";
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

function highlightSublane(ctx, sublane, x1, x2) {
  const y = CONFIG.playerCapital.y
    + Path.sublaneNorm(sublane, CONFIG.topSublaneCount) * CONFIG.topSublaneSpread;
  ctx.save();
  ctx.strokeStyle = CONFIG.colors.laneHover;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = CONFIG.topSublaneWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
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
  ink(ctx, "cover", Math.max(36, at.x - 8), at.y, CONFIG.colors.player, 12, "right");
  const town = townSpots()[2];
  const townAt = toScreen(frame, town.x, town.y);
  ink(ctx, "towns", townAt.x, Math.min(h - 12, townAt.y + 22), CONFIG.colors.text, 12);
}

function drawSpeedLadder(ctx, rect) {
  ctx.fillStyle = "#1a2838";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = "#314257";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

  const steps = [
    { order: "retreat", name: "Retreat" },
    { order: "fallback", name: "Fall back" },
    { order: "halt", name: "Halt" },
    { order: null, name: "Advance" },
    { order: "charge", name: "Charge" },
  ];
  const pad = 8;
  const slot = (rect.w - pad * 2) / steps.length;
  const cy = rect.y + rect.h * 0.38;
  const scale = Math.min(1.35, Math.max(1, (slot - 8) / 36));
  const haltAt = steps.findIndex((step) => step.order === "halt");
  for (let i = 0; i < steps.length; i += 1) {
    const cx = rect.x + pad + slot * (i + 0.5);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    drawUnit(ctx, { x: 0, y: 0, side: "player", type: "troop", order: steps[i].order });
    ctx.restore();
    inkFit(ctx, steps[i].name, cx, cy + 26 + scale * 4, CONFIG.colors.text, 11, slot - 4);
  }
  for (let i = 0; i < steps.length - 1; i += 1) {
    const from = rect.x + pad + slot * (i + 0.5);
    const to = rect.x + pad + slot * (i + 1.5);
    const gap = 10 + scale * 10;
    const x1 = from + gap;
    const x2 = to - gap;
    if (x2 <= x1 + 8) continue;
    if (i < haltAt) {
      worldArrow(ctx, x2, cy, x1, cy, "#8aa0b8");
    } else {
      worldArrow(ctx, x1, cy, x2, cy, "#8aa0b8");
    }
  }
  inkFit(ctx, "back: fall back · forward: charge", rect.x + rect.w / 2, rect.y + rect.h - 12, CONFIG.colors.gold, 12, rect.w - 16);
}

function drawOrders(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 2);
  drawSpeedLadder(ctx, panels[0]);

  const reforming = placeX("player", 2, 500, "troop", "reform");
  vignette(ctx, panels[1], around([reforming], 70, 36), "Click · Halt, reform, advance", () => {
    drawGround(ctx);
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(reforming.x, reforming.y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawUnit(ctx, reforming);
  });

  const charger = placeX("player", 2, 470, "troop", "charge");
  const chargeFoe = placeX("enemy", 2, 560, "troop");
  vignette(ctx, panels[2], around([charger, chargeFoe], 70, 36), "Swipe forward · charge", () => {
    drawGround(ctx);
    worldArrow(ctx, charger.x - 36, charger.y - 28, chargeFoe.x - 16, charger.y - 28, CONFIG.colors.charge);
    drawUnit(ctx, charger);
    drawUnit(ctx, chargeFoe);
  });

  const slider = placeX("player", 2, 500, "troop");
  vignette(ctx, panels[3], around([slider], 80, 20), "Swipe up or down · shift row", () => {
    drawGround(ctx);
    highlightSublane(ctx, 1, slider.x - 90, slider.x + 90);
    worldArrow(ctx, slider.x + 26, slider.y - 4, slider.x + 26, slider.y - 28, CONFIG.colors.laneHover);
    drawUnit(ctx, slider);
  });
}

function drawLines(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 1);
  const formed = [1, 2, 3].map((row) => place("player", "top", row, 0.5, "troop", "reform"));
  vignette(ctx, panels[0], around(formed, 56, 28), "One line · stronger melee", () => {
    drawGround(ctx);
    for (let i = 0; i < formed.length; i += 1) drawUnit(ctx, formed[i]);
  });

  const leftLine = [
    place("player", "top", 0, 0.5, "troop", "halt"),
    place("player", "top", 1, 0.5, "troop", "halt"),
  ];
  const rightLine = [
    place("player", "top", 3, 0.5, "troop", "reform"),
    place("player", "top", 4, 0.5, "troop", "reform"),
  ];
  const split = leftLine.concat(rightLine);
  vignette(ctx, panels[1], around(split, 56, 24), "An empty row splits them", () => {
    drawGround(ctx);
    highlightSublane(ctx, 2, split[0].x - 70, split[0].x + 70);
    for (let i = 0; i < split.length; i += 1) drawUnit(ctx, split[i]);
  });
}

function drawFighting(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 3, 1);
  const rear = placeX("player", 1, 500, "troop");
  const front = placeX("player", 2, 508, "troop");
  const shotFoe = placeX("enemy", 2, 608, "troop");
  const shooters = [rear, front, shotFoe];
  vignette(ctx, panels[0], around(shooters, 36, 28), "Shot", () => {
    drawGround(ctx);
    drawUnit(ctx, rear);
    drawUnit(ctx, front);
    drawUnit(ctx, shotFoe);
    drawShot(ctx, (front.x + shotFoe.x) / 2, front.y - 14);
    drawSplat(ctx, shotFoe.x, shotFoe.y, rangedHit(front, shotFoe, "troop"), "shoot");
  });

  const chargeFoe = placeX("enemy", 2, 560, "troop");
  const charger = placeX("player", 2, 538, "troop", "charge");
  vignette(ctx, panels[1], around([charger, chargeFoe], 48, 32), "Charge", () => {
    drawGround(ctx);
    drawUnit(ctx, charger);
    drawUnit(ctx, chargeFoe);
    drawSplat(ctx, chargeFoe.x, chargeFoe.y, meleeHit("troop", { charge: true }), "melee");
  });

  const flankFoe = placeX("enemy", 2, 560, "troop");
  const holder = placeX("player", 2, 538, "troop", "charge");
  const dragoon = placeX("player", 3, 560, "dragoon", "charge");
  vignette(ctx, panels[2], around([holder, flankFoe, dragoon], 46, 24), "Flank", () => {
    drawGround(ctx);
    highlightSublane(ctx, dragoon.sublane, dragoon.x - 80, dragoon.x + 80);
    drawUnit(ctx, holder);
    drawUnit(ctx, flankFoe);
    drawUnit(ctx, dragoon);
    drawSplat(
      ctx,
      dragoon.x,
      dragoon.y,
      meleeHit("dragoon", { charge: true, flank: true }),
      "melee",
    );
  });
}

function drawRankDots(ctx, x, y, filled, max, gap) {
  const r = 3.5;
  const total = (max - 1) * gap;
  const start = x - total / 2;
  for (let i = 0; i < max; i += 1) {
    const cx = start + i * gap;
    ctx.beginPath();
    ctx.arc(cx, y, r, 0, Math.PI * 2);
    if (i < filled) {
      ctx.fillStyle = CONFIG.colors.gold;
      ctx.fill();
    } else {
      ctx.fillStyle = "#2a3648";
      ctx.fill();
      ctx.strokeStyle = "#6a7a8c";
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
  }
}

function drawEconomy(ctx, w, h) {
  clear(ctx, w, h);
  const stripH = 64;
  const mapH = Math.max(140, h - stripH - 8);
  const owners = ["player", "player", "player", "enemy", null];
  const spots = townSpots();
  const pick = Math.floor(CONFIG.checkpointCount / 2);
  const box = { l: 80, t: 260, r: 880, b: 610 };
  const frame = withWorld(ctx, { x: 0, y: 0, w, h: mapH }, box, { t: 6, r: 10, b: 6, l: 10 }, () => {
    drawGround(ctx);
    drawKeep(ctx, "player");
    drawKeep(ctx, "enemy");
    for (let i = 0; i < spots.length; i += 1) {
      drawTownMarker(ctx, spots[i], owners[i], i === pick);
    }
    const claimer = place("player", "bottom", 1, 0.52, "troop");
    drawUnit(ctx, claimer);
  });

  const buy = spots[pick];
  const buyAt = toScreen(frame, buy.x, buy.y);
  const costY = Math.max(14, buyAt.y - buy.r * frame.scale - 8);
  ink(ctx, `${CONFIG.upgradeBaseCost}🌿`, buyAt.x, costY, CONFIG.colors.gold, 13);
  ink(ctx, "click to upgrade", buyAt.x, Math.min(mapH - 6, buyAt.y + buy.r * frame.scale + 12), CONFIG.colors.text, 11);

  const stripY = mapH + stripH / 2;
  const tracks = [
    { kind: "speed", name: "Speed", filled: 2 },
    { kind: "armor", name: "Armor", filled: 1 },
    { kind: "damage", name: "Damage", filled: 0 },
  ];
  const col = w / tracks.length;
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i];
    const cx = col * i + col / 2;
    ctx.beginPath();
    ctx.arc(cx - 36, stripY, 11, 0, Math.PI * 2);
    ctx.fillStyle = CONFIG.colors.player;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#0d1218";
    ctx.stroke();
    drawKindGlyph(ctx, cx - 36, stripY, 7.5, track.kind, CONFIG.colors.text);
    ink(ctx, track.name, cx + 2, stripY - 7, CONFIG.colors.text, 12, "left");
    drawRankDots(ctx, cx + 22, stripY + 9, track.filled, CONFIG.upgradeMax, 11);
  }
}

function drawRoster(ctx, w, h, roster, banner) {
  clear(ctx, w, h);
  const bw = Math.min(280, w - 24);
  const bh = 36;
  const bx = (w - bw) / 2;
  const by = 8;
  ctx.fillStyle = "#2a4158";
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
  inkFit(ctx, banner, bx + bw / 2, by + bh / 2, "#ffffff", 14, bw - 16);

  const col = w / roster.length;
  const cy = by + bh + (h - by - bh) * 0.34;
  let maxRange = 1;
  for (let i = 0; i < roster.length; i += 1) {
    maxRange = Math.max(maxRange, unitStats(roster[i].type).range);
  }
  const shellColor = UNIT_STATS.troop.projectileColor;
  for (let i = 0; i < roster.length; i += 1) {
    const info = roster[i];
    const stats = unitStats(info.type);
    const cx = col * i + col / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(2, 2);
    drawUnit(ctx, {
      x: 0,
      y: 0,
      side: "player",
      type: info.base || info.type,
      variant: info.type,
      alternate: Boolean(info.alternate),
      order: null,
    });
    ctx.restore();
    inkFit(ctx, info.name, cx, cy + 32, CONFIG.colors.text, 13, col - 6);
    inkFit(ctx, `${stats.cost}💰`, cx, cy + 48, CONFIG.colors.gold, 12, col - 6);
    inkFit(ctx, `${stats.hp} HP`, cx, cy + 64, CONFIG.colors.text, 11, col - 6);
    const maxBar = Math.min(col * 0.7, 96);
    const bar = maxBar * (stats.range / maxRange);
    ctx.fillStyle = "#3a3420";
    ctx.fillRect(cx - maxBar / 2, cy + 78, maxBar, 4);
    ctx.fillStyle = shellColor;
    ctx.fillRect(cx - maxBar / 2, cy + 78, bar, 4);
    inkFit(ctx, `${stats.range} range`, cx, cy + 92, shellColor, 11, col - 4);
  }
}

function drawUnits(ctx, w, h) {
  drawRoster(ctx, w, h, BUY_UNITS.map((unit) => ({
    type: unit.type,
    name: UNIT_LABELS[unit.type] || unit.label,
  })), "Drag up · top    Drag down · bottom");
}

function drawVariants(ctx, w, h) {
  const roster = BUY_UNITS.map((unit) => {
    const type = UNIT_VARIANTS[unit.type];
    return {
      type,
      base: unit.type,
      alternate: true,
      name: UNIT_LABELS[type] || type,
    };
  });
  drawRoster(ctx, w, h, roster, "Unlock with land · drag sideways");
}

function drawFatigue(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 1);
  const worn = placeX("player", 2, 500, "troop");
  worn.hp = Math.round(UNIT_STATS.troop.hp * 0.25);
  worn.fatigue = Math.round(UNIT_STATS.troop.fatigue * 0.8);
  vignette(ctx, panels[0], around([worn], 70, 36), "Fatigue above health can break", () => {
    drawGround(ctx);
    drawUnit(ctx, worn);
  });

  const off = placeX("player", 2, 470, "officer");
  const ally = placeX("player", 1, 500, "troop");
  ally.fatigue = Math.round(UNIT_STATS.troop.fatigue * 0.55);
  vignette(ctx, panels[1], around([off, ally], 80, 40), "Officer restores nearby fatigue", () => {
    drawGround(ctx);
    ctx.save();
    ctx.strokeStyle = CONFIG.colors.gold;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(off.x, off.y, UNIT_STATS.officer.restoreRange, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawUnit(ctx, off);
    drawUnit(ctx, ally);
  });
}

const pages = [
  {
    title: "Keeps",
    artHeight: 230,
    blocks(southpaw) {
      const you = southpaw ? "right" : "left";
      const them = southpaw ? "left" : "right";
      return [
        { kind: "p", text: `Destroy the enemy keep. Yours is blue, on the ${you}. Theirs is red, on the ${them}. Health is shown at the top of the board.` },
        { kind: "p", text: "Each keep shoots nearby enemies on its own. Units that reach a keep can strike it. The match ends when a keep falls." },
      ];
    },
    draw: drawKeeps,
  },
  {
    title: "Lanes",
    aspect: 1.45,
    blocks: [
      { kind: "p", text: "The top lane is straight rows. Your share of that lane pays gold. Units count more the farther they push and the more health they have. Broken units do not count." },
      { kind: "p", text: "The bottom lane is curved rows and pays \"land\" the same way. An empty lane is split." },
      { kind: "p", text: "Towns sit inside the bottom curve. The last unit through a town claims it. Click a town you own to buy its upgrade. The pale bars near each keep are cover, and units on them take less damage." },
    ],
    draw: drawLanes,
  },
  {
    title: "Units",
    artHeight: 300,
    blocks: [
      { kind: "p", text: "Drag up from a buy button for the top lane, or down for the bottom." },
      {
        kind: "ul",
        items: [
          "Troops: Are more durable, and do more damage when in a line.",
          "Skirmishers: Harass, slow, and break enemy lines. Snipe officers.",
          "Dragoons: Fast units that do bonus flank damage, but have poor shooting.",
          "Cannons: Long-range splash damage, but no close fighting.",
          "Officers: Holds discipline by restoring nearby fatigue. Lead better from the front of the line.",
        ],
      },
      { kind: "p", text: "Units block each other on the same row. When blocked ahead they look for any row they can enter without overlapping a friendly, prefer the one with the most open space ahead, and step one adjacent row at a time toward it — easing back only when the next step is occupied. That lets them move around formed lines instead of bouncing between rows. Fall back and retreat pass through friendlies; charging cavalry do too. When a unit stops passing through while stacked (for example cavalry halting after a charge), it eases away from the closest overlapping friendly until clear before it acts on its order. Skirmishers and officers on advance pass through other types, but not through each other. Most units ignore officers while another enemy is in range." },
    ],
    draw: drawUnits,
  },
  {
    title: "Variants",
    artHeight: 300,
    blocks: [
      { kind: "p", text: "Each unit has an alternate unlocked with land for the match. Drag sideways on a buy button to switch. Alternates wear a white square." },
      {
        kind: "ul",
        items: [
          "Grenadier: Tougher troops who prefer to fight up close.",
          "Rifle: Longer, harder shot with a slower reload.",
          "Lancer: Do regular flank damage but increased charge damage.",
          "Howitzer: Shorter gun that hits a whole line.",
          "Color: Raises moral by restoring nearby fatigue and bolstering attack and speed.",
        ],
      },
    ],
    draw: drawVariants,
  },
  {
    title: "Orders",
    artHeight: 320,
    blocks: [
      { kind: "p", text: "Click a unit to halt its line, then reform, then advance. Giving an order selects that line. Long press a unit to select it alone, then swipe it up or down onto a row. Swipe a line up or down and each unit switches one row that way. Broken and retreating units cannot switch." },
      { kind: "p", text: "Units in melee can be given orders, but those orders wait until the fight breaks. Reform and fall back start at once. They can leave by falling back, or by switching to a row that is not next to theirs. A fall back that leaves the fight becomes a retreat, and the unit is not broken. A charging unit still does charge damage while it is in melee, and swiping back then falls back instead of advancing." },
      {
        kind: "ul",
        items: [
          "Halt: Stay in place. Recover fatigue and shoot full distance. Still collides with friendlies.",
          "Reform: Slow down to form a line. Sidesteps blockers like an advance.",
          "Advance: Walk and shoot. When blocked, pick the clearest open row ahead and step toward it; ease back only if the next step is occupied.",
          "Charge: Swipe forward. Stop shooting, run faster, and do bonus melee damage, but fatigue rises. A forward swipe while halted advances instead. Cavalry pass through friendlies while charging.",
          "Fall back: Swipe back. Disengage and withdraw through friendlies while firing. A back swipe while charging advances instead.",
          "Retreat: Broken units only. They run back until fatigue is full, then fall back until fatigue is half their current health. You cannot order a retreat.",
        ],
      },
    ],
    draw: drawOrders,
  },
  {
    title: "Lines",
    artHeight: 240,
    blocks: [
      { kind: "p", text: "A line is same-type units in neighboring rows, one per row. An empty row splits them. An order applies to the whole line." },
      { kind: "p", text: "Advancing lines hold and shoot together once anyone has opened fire. Reforming lines slow and square up. Units who get into line with another unit gain that unit's order." },
    ],
    draw: drawLines,
  },
  {
    title: "Fighting",
    artHeight: 250,
    blocks: [
      { kind: "p", text: "Units shoot only inside engagement range, or at full range while halted. A lined mate who has opened fire lets the rest of the line shoot at that same range. Shots weaken with distance. Melee does not. Yellow numbers are shots, red are melee." },
      { kind: "p", text: "Charge and flank raise melee damage. Shots briefly slow advancing or charging units. Halt and reform ignore the slow. Units in melee are not targeted until they leave it." },
    ],
    draw: drawFighting,
  },
  {
    title: "Fatigue",
    artHeight: 240,
    blocks: [
      { kind: "p", text: "The blue bar is fatigue. Charging, retreating, fighting in melee, and getting hit increase it. Halting, being near an officer, or standing in your keep decrease it." },
      { kind: "p", text: "When your fatigue is fuller than your health, hits can break the unit. Broken units retreat until fatigue is full, then fall back until fatigue is half their current health. They stop fighting and ignore orders until they rally." },
    ],
    draw: drawFatigue,
  },
  {
    title: "Gold and land",
    artHeight: 300,
    blocks: [
      { kind: "p", text: "Gold buys units and banks. Land buys upgrades and unit variants. You earn base gold, a share of the top lane, and bank income. Land comes from your share of the bottom lane." },
      { kind: "p", text: "Banks unlock over time and can be purchased to raise gold income. Click a town you own to upgrade speed, armor, or damage for your army." },
    ],
    draw: drawEconomy,
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
  const pageMode = Boolean(options && options.page);
  const book = document.getElementById("book");
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
    const page = pages[index];
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
    pages[index].draw(ctx, w, h);
  }

  function render() {
    const page = pages[index];
    title.textContent = page.title;
    const blocks = typeof page.blocks === "function" ? page.blocks(readSouthpaw()) : page.blocks;
    fillCopy(copy, blocks);
    pageLabel.textContent = `${index + 1} / ${pages.length}`;
    prev.disabled = index === 0;
    next.disabled = index === pages.length - 1;
    dots.replaceChildren();
    for (let i = 0; i < pages.length; i += 1) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "rules-dot";
      dot.setAttribute("aria-label", pages[i].title);
      dot.setAttribute("aria-current", i === index ? "true" : "false");
      dot.addEventListener("click", () => go(i));
      dots.appendChild(dot);
    }
    paint();
  }

  function go(nextIndex) {
    index = Math.max(0, Math.min(pages.length - 1, nextIndex));
    render();
    const card = overlay.querySelector(".rules-card") || overlay;
    card.scrollTop = 0;
    if (pageMode) window.scrollTo(0, 0);
  }

  function hide() {
    if (pageMode) return;
    overlay.classList.add("hidden");
    if (book) book.setAttribute("aria-expanded", "false");
  }

  function show() {
    const wasHidden = overlay.classList.contains("hidden");
    if (wasHidden && onOpen) onOpen();
    overlay.classList.remove("hidden");
    if (book) book.setAttribute("aria-expanded", "true");
    render();
    requestAnimationFrame(paint);
    if (wasHidden && !pageMode) overlay.focus();
  }

  if (book) book.addEventListener("click", show);
  if (close) close.addEventListener("click", hide);
  prev.addEventListener("click", () => go(index - 1));
  next.addEventListener("click", () => go(index + 1));
  if (!pageMode) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) hide();
    });
  }
  document.addEventListener("keydown", (event) => {
    if (!pageMode && overlay.classList.contains("hidden")) return;
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

  if (pageMode) show();

  return {
    close: hide,
    repaint() {
      if (!overlay.classList.contains("hidden")) render();
    },
  };
}
