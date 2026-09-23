import { CONFIG } from "../shared/config.js";
import { Path, quarterSegments, quarterThickness } from "../shared/path.js";
import { applySouthpaw, readSouthpaw } from "./render.js";

/** Rules booklet. Diagrams use the board's shapes, colors, and numbers. */

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
  if (type === "cannon") return CONFIG.cannonCost;
  if (type === "dragoon") return CONFIG.dragoonCost;
  if (type === "skirmisher") return CONFIG.skirmisherCost;
  return CONFIG.troopCost;
}

function armyShare(units, lane) {
  let player = 0;
  let enemy = 0;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit.lane !== lane) continue;
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
  const base = type === "cannon"
    ? CONFIG.cannonDamage
    : type === "dragoon"
      ? CONFIG.dragoonRangedDamage
      : type === "skirmisher"
        ? CONFIG.skirmisherRangedDamage
        : CONFIG.troopRangedDamage;
  const range = type === "cannon"
    ? CONFIG.cannonRange
    : type === "skirmisher"
      ? CONFIG.skirmisherRange
      : CONFIG.troopRange;
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const falloff = Math.max(CONFIG.minDamageFactor, 1 - dist / Math.max(range, 1));
  return Math.round(base * falloff);
}

function meleeHit(type, flags) {
  let damage = type === "dragoon"
    ? CONFIG.dragoonMeleeDamage
    : type === "skirmisher"
      ? CONFIG.skirmisherMeleeDamage
      : CONFIG.troopMeleeDamage;
  if (flags.charge) damage *= CONFIG.doubleDamageMultiplier;
  if (flags.flank) {
    damage *= CONFIG.doubleDamageMultiplier;
    if (type === "dragoon") damage *= CONFIG.dragoonFlankBonus;
  }
  if (type === "melee") {
    damage *= 1 + (flags.lineMates || 0) * CONFIG.lineDamageBonus;
  }
  return Math.round(damage);
}

function orderStroke(order) {
  if (order === "halt") return CONFIG.colors.halt;
  if (order === "reform") return CONFIG.colors.reform;
  if (order === "charge") return CONFIG.colors.charge;
  if (order === "fallback") return CONFIG.colors.fallback;
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
    || unit.order === "charge" || unit.order === "fallback";
  ctx.fillStyle = color;
  ctx.strokeStyle = orderStroke(unit.order);
  ctx.lineWidth = ordered ? 3 : 2;
  const x = unit.x;
  const y = unit.y;

  if (unit.type === "cannon") {
    ctx.beginPath();
    ctx.arc(x, y, CONFIG.cannonRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (unit.type === "skirmisher") {
    const r = CONFIG.skirmisherRadius;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.lineTo(x - r, y + r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (unit.type === "dragoon") {
    const r = CONFIG.troopRadius;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    const tan = unitTangent(unit);
    const len = CONFIG.troopRadius * 0.6;
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

  const radius = unit.type === "cannon"
    ? CONFIG.cannonRadius
    : unit.type === "skirmisher"
      ? CONFIG.skirmisherRadius
      : CONFIG.troopRadius;
  const maxHp = unit.type === "skirmisher" ? CONFIG.skirmisherHP : CONFIG.troopHP;
  const ratio = unit.hp == null ? 1 : Math.max(0, unit.hp) / maxHp;
  const barW = radius * 2;
  ctx.fillStyle = "#1a1510";
  ctx.fillRect(x - barW / 2, y - 1.5, barW, 3);
  ctx.fillStyle = CONFIG.colors.gold;
  ctx.fillRect(x - barW / 2, y - 1.5, barW * ratio, 3);
}

function drawShot(ctx, x, y) {
  ctx.beginPath();
  ctx.arc(x, y, CONFIG.projectileRadius, 0, Math.PI * 2);
  ctx.fillStyle = CONFIG.colors.projectile;
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

function drawKeepGlyph(ctx, x, y, r, side) {
  const color = side === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
  const dark = side === "player" ? CONFIG.colors.playerDark : CONFIG.colors.enemyDark;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = dark;
  ctx.fill();
  ctx.lineWidth = Math.max(3, r * 0.16);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
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
  const icon = spot.kind === "speed" ? "⚡" : spot.kind === "armor" ? "🛡️" : "⚔️";
  ctx.font = `${Math.max(10, spot.r * 0.85)}px Trebuchet MS, Segoe UI, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#0d1218";
  ctx.fillText(icon, spot.x, spot.y);
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
  const head = 9;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
  ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
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
  const foe = placeX("enemy", 2, 200, "melee");
  const friend = placeX("player", 2, 790, "melee");
  vignette(ctx, panels[0], { l: 24, t: 90, r: 250, b: 220 }, "Your keep fires", (frame) => {
    drawGround(ctx);
    drawKeep(ctx, "player");
    drawUnit(ctx, foe);
    drawShot(ctx, (CONFIG.playerCapital.x + foe.x) / 2, foe.y - 16);
    zoomInk(ctx, frame, "500", CONFIG.playerCapital.x, CONFIG.playerCapital.y + 52, CONFIG.colors.player, 16);
  });
  vignette(ctx, panels[1], { l: 710, t: 90, r: 936, b: 220 }, "Strike their keep", (frame) => {
    drawGround(ctx);
    drawKeep(ctx, "enemy");
    drawUnit(ctx, friend);
    drawShot(ctx, (friend.x + CONFIG.enemyCapital.x) / 2, friend.y - 16);
    zoomInk(ctx, frame, "500", CONFIG.enemyCapital.x, CONFIG.enemyCapital.y + 52, CONFIG.colors.enemy, 16);
  });
}

function drawLanes(ctx, w, h) {
  clear(ctx, w, h);
  const units = [
    place("player", "top", 2, 0.7, "melee"),
    place("player", "top", 0, 0.45, "skirmisher"),
    place("enemy", "top", 4, 0.2, "cannon"),
    place("player", "bottom", 1, 0.3, "melee"),
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

function chevron(ctx, cx, cy, up, color) {
  const s = 6;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(cx, cy - s);
    ctx.lineTo(cx - s, cy + s * 0.55);
    ctx.lineTo(cx + s, cy + s * 0.55);
  } else {
    ctx.moveTo(cx, cy + s);
    ctx.lineTo(cx - s, cy - s * 0.55);
    ctx.lineTo(cx + s, cy - s * 0.55);
  }
  ctx.closePath();
  ctx.fill();
}

function drawUnits(ctx, w, h) {
  clear(ctx, w, h);
  const bw = Math.min(230, w - 24);
  const bh = 62;
  const bx = (w - bw) / 2;
  const by = 8;
  ctx.fillStyle = "#2a4158";
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fillRect(bx, by, bw, bh / 2);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
  chevron(ctx, bx + 16, by + bh * 0.25, true, "#ffffff");
  inkFit(ctx, "Drag up · top lane", bx + bw / 2 + 6, by + bh * 0.25, "#ffffff", 14, bw - 44);
  chevron(ctx, bx + 16, by + bh * 0.75, false, CONFIG.colors.gold);
  inkFit(ctx, "Drag down · bottom", bx + bw / 2 + 6, by + bh * 0.75, CONFIG.colors.gold, 14, bw - 44);

  const roster = [
    { type: "melee", name: "Troop", cost: CONFIG.troopCost, hp: CONFIG.troopHP, range: CONFIG.troopRange },
    { type: "skirmisher", name: "Skirmish", cost: CONFIG.skirmisherCost, hp: CONFIG.skirmisherHP, range: CONFIG.skirmisherRange },
    { type: "dragoon", name: "Dragoon", cost: CONFIG.dragoonCost, hp: CONFIG.troopHP, range: CONFIG.troopRange },
    { type: "cannon", name: "Cannon", cost: CONFIG.cannonCost, hp: CONFIG.troopHP, range: CONFIG.cannonRange },
  ];
  const col = w / roster.length;
  const cy = by + bh + (h - by - bh) * 0.36;
  for (let i = 0; i < roster.length; i += 1) {
    const info = roster[i];
    const cx = col * i + col / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(2, 2);
    drawUnit(ctx, { x: 0, y: 0, side: "player", type: info.type, order: null });
    ctx.restore();
    inkFit(ctx, info.name, cx, cy + 32, CONFIG.colors.text, 14, col - 8);
    inkFit(ctx, `${info.cost}💰`, cx, cy + 50, CONFIG.colors.gold, 13, col - 8);
    inkFit(ctx, `${info.hp} HP`, cx, cy + 68, CONFIG.colors.text, 12, col - 8);
    const maxBar = Math.min(col * 0.7, 96);
    const bar = maxBar * (info.range / CONFIG.cannonRange);
    ctx.fillStyle = "#3a3420";
    ctx.fillRect(cx - maxBar / 2, cy + 82, maxBar, 4);
    ctx.fillStyle = CONFIG.colors.projectile;
    ctx.fillRect(cx - maxBar / 2, cy + 82, bar, 4);
    inkFit(ctx, `${info.range} range`, cx, cy + 98, CONFIG.colors.projectile, 11, col - 6);
  }
}

function drawCycle(ctx, rect) {
  ctx.fillStyle = CONFIG.colors.bg;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = "#314257";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  const steps = [
    { order: null, name: "Advance" },
    { order: "halt", name: "Halt" },
    { order: "reform", name: "Reform" },
  ];
  const slot = rect.w / steps.length;
  const cy = rect.y + rect.h * 0.36;
  const scale = Math.min(1.7, Math.max(1, (slot - 12) / 34));
  for (let i = 0; i < steps.length; i += 1) {
    const cx = rect.x + slot * (i + 0.5);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    drawUnit(ctx, { x: 0, y: 0, side: "player", type: "melee", order: steps[i].order });
    ctx.restore();
    inkFit(ctx, steps[i].name, cx, cy + 28 + scale * 6, CONFIG.colors.text, 12, slot - 8);
    if (i < steps.length - 1 && slot > 48) {
      const inset = Math.max(14, scale * 16);
      const nextCx = rect.x + slot * (i + 1.5);
      if (nextCx - inset > cx + inset + 8) {
        worldArrow(ctx, cx + inset, cy, nextCx - inset, cy, CONFIG.colors.text);
      }
    }
  }
  inkFit(ctx, "Click", rect.x + rect.w / 2, rect.y + rect.h - 12, CONFIG.colors.gold, 13, rect.w - 10);
}

function drawOrders(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 2);
  drawCycle(ctx, panels[0]);

  const charger = placeX("player", 2, 470, "melee", "charge");
  const chargeFoe = placeX("enemy", 2, 560, "melee");
  vignette(ctx, panels[1], around([charger, chargeFoe], 70, 36), "Drag toward the enemy", () => {
    drawGround(ctx);
    worldArrow(ctx, charger.x - 36, charger.y - 28, chargeFoe.x - 16, charger.y - 28, CONFIG.colors.charge);
    drawUnit(ctx, charger);
    drawUnit(ctx, chargeFoe);
  });

  const back = placeX("player", 2, 520, "melee", "fallback");
  const backFoe = placeX("enemy", 2, 610, "melee");
  vignette(ctx, panels[2], around([back, backFoe], 70, 36), "Drag toward your keep", () => {
    drawGround(ctx);
    worldArrow(ctx, back.x + 28, back.y - 28, back.x - 48, back.y - 28, CONFIG.colors.fallback);
    drawUnit(ctx, back);
    drawUnit(ctx, backFoe);
  });

  const slider = placeX("player", 2, 500, "melee");
  vignette(ctx, panels[3], around([slider], 80, 20), "Drag across rows", () => {
    drawGround(ctx);
    highlightSublane(ctx, 1, slider.x - 90, slider.x + 90);
    worldArrow(ctx, slider.x + 26, slider.y - 4, slider.x + 26, slider.y - 28, CONFIG.colors.laneHover);
    drawUnit(ctx, slider);
  });
}

function drawLines(ctx, w, h) {
  clear(ctx, w, h);
  const panels = cells(w, h, 2, 1);
  const formed = [1, 2, 3].map((row) => place("player", "top", row, 0.5, "melee", "reform"));
  vignette(ctx, panels[0], around(formed, 56, 28), "One line · +40% melee", () => {
    drawGround(ctx);
    for (let i = 0; i < formed.length; i += 1) drawUnit(ctx, formed[i]);
  });

  const leftLine = [
    place("player", "top", 0, 0.5, "melee", "halt"),
    place("player", "top", 1, 0.5, "melee", "halt"),
  ];
  const rightLine = [
    place("player", "top", 3, 0.5, "melee", "reform"),
    place("player", "top", 4, 0.5, "melee", "reform"),
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
  const rear = placeX("player", 1, 500, "melee");
  const front = placeX("player", 2, 508, "melee");
  const shotFoe = placeX("enemy", 2, 608, "melee");
  const shooters = [rear, front, shotFoe];
  vignette(ctx, panels[0], around(shooters, 36, 28), "Shot", () => {
    drawGround(ctx);
    drawUnit(ctx, rear);
    drawUnit(ctx, front);
    drawUnit(ctx, shotFoe);
    drawShot(ctx, (front.x + shotFoe.x) / 2, front.y - 14);
    drawSplat(ctx, shotFoe.x, shotFoe.y, rangedHit(front, shotFoe, "melee"), "shoot");
  });

  const chargeFoe = placeX("enemy", 2, 560, "melee");
  const charger = placeX("player", 2, 538, "melee", "charge");
  vignette(ctx, panels[1], around([charger, chargeFoe], 48, 32), "Charge", () => {
    drawGround(ctx);
    drawUnit(ctx, charger);
    drawUnit(ctx, chargeFoe);
    drawSplat(ctx, chargeFoe.x, chargeFoe.y, meleeHit("melee", { charge: true }), "melee");
  });

  const flankFoe = placeX("enemy", 2, 560, "melee");
  const holder = placeX("player", 2, 538, "melee", "charge");
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

function drawBank(ctx, x, y, size, mode) {
  ctx.fillStyle = mode === "open" ? CONFIG.colors.gold : "#2a3340";
  ctx.fillRect(x, y, size, size);
  ctx.lineWidth = 2;
  ctx.strokeStyle = mode === "next" ? "#ffffff" : "#0d1218";
  ctx.strokeRect(x + 1, y + 1, size - 2, size - 2);
}

function drawTownIcon(ctx, x, y, r, owner, kind, ring) {
  drawTownMarker(ctx, { x, y, r, kind }, owner, ring);
}

function drawEconomy(ctx, w, h) {
  clear(ctx, w, h);
  const wide = w >= 560;
  const bankSize = wide ? 46 : 40;
  const bankGap = 10;
  const bankRow = bankSize * 3 + bankGap * 2;
  const left = wide ? 28 : (w - (bankRow + 58)) / 2;
  const top = wide ? 56 : 28;
  drawKeepGlyph(ctx, left + 16, top + bankSize + 8, 22, "player");
  const banksX = left + 48;
  const banks = [
    { mode: "open", caption: "2:00" },
    { mode: "next", caption: "4:00 · 200" },
    { mode: "locked", caption: "6:00 · 300" },
  ];
  for (let i = 0; i < banks.length; i += 1) {
    const x = banksX + i * (bankSize + bankGap);
    drawBank(ctx, x, top, bankSize, banks[i].mode);
    inkFit(ctx, banks[i].caption, x + bankSize / 2, top + bankSize + 14, CONFIG.colors.text, 12, bankSize + bankGap - 2);
  }
  inkFit(
    ctx,
    "+1, then +3, then +6 gold/s",
    banksX + bankRow / 2,
    top + bankSize + 34,
    CONFIG.colors.gold,
    13,
    wide ? w * 0.46 : w - 16,
  );

  const kinds = ["speed", "armor", "damage", "armor", "speed"];
  const owners = ["player", "player", "player", "enemy", null];
  const names = ["speed", "armor", "damage", "armor", "speed"];
  const regionX = wide ? w * 0.52 : 12;
  const regionW = wide ? w * 0.46 : w - 24;
  const townY = wide ? h * 0.48 : h * 0.62;
  const townR = Math.min(18, regionW / kinds.length / 2 - 4);
  const step = regionW / kinds.length;
  ink(ctx, "Towns", regionX + regionW / 2, townY - townR - 16, CONFIG.colors.text, 13);
  for (let i = 0; i < kinds.length; i += 1) {
    const x = regionX + step * (i + 0.5);
    const ring = i === 2;
    drawTownIcon(ctx, x, townY, townR, owners[i], kinds[i], ring);
    inkFit(ctx, names[i], x, townY + townR + 12, CONFIG.colors.text, 11, step - 2);
    if (ring) {
      inkFit(ctx, `${CONFIG.upgradeBaseCost}🌿`, x, townY + townR + 26, CONFIG.colors.gold, 11, step - 2);
    }
  }
}

const pages = [
  {
    title: "Keeps",
    artHeight: 230,
    blocks(southpaw) {
      const you = southpaw ? "right" : "left";
      const them = southpaw ? "left" : "right";
      return [
        { kind: "p", text: `Destroy the enemy keep. Both keeps start at 500 health, shown at the top of the board. Yours is blue, on the ${you}. Theirs is red, on the ${them}.` },
        { kind: "p", text: "Each keep fires on its own at enemies that come into range. That gun is shorter and lighter than a field cannon, and it fires quickly. A unit that reaches the enemy keep can strike it. The match ends when a keep hits 0." },
      ];
    },
    draw: drawKeeps,
  },
  {
    title: "Lanes",
    aspect: 1.45,
    blocks: [
      { kind: "p", text: "The top lane is five straight rows. The gold line is your share of that lane, and it pays up to 10 gold per second. A unit counts more the farther it has pushed from your keep, and more if it cost more gold. The farther the line sits toward the enemy keep, the more of that gold is yours." },
      { kind: "p", text: "The bottom lane is three curved rows. The gold ray there pays \"Land\" the same way, up to 10 per second. Land is used to buy upgrades. With nobody on a lane, that 10 is split." },
      { kind: "p", text: "Towns sit inside the bottom curve. The last unit to pass a town on any bottom row takes it, and each town you hold adds 1 gold per second. The pale bars a quarter of the way out from each keep, on both lanes, are cover. A unit standing on one takes less damage." },
    ],
    draw: drawLanes,
  },
  {
    title: "Units",
    artHeight: 290,
    blocks: [
      { kind: "p", text: "Drag up from a buy button to build on the top lane, or down to build on the bottom." },
      {
        kind: "ul",
        items: [
          "Troop: melee hits harder for each other troop in its line.",
          "Skirmisher: fires a little faster, and walks through friendly units.",
          "Dragoon: flanks hit harder, and it walks twice as fast.",
          "Cannon: shells splash half damage onto enemies one row over in the same line. It fires slowly, and it cannot shoot or fight up close.",
        ],
      },
      { kind: "p", text: "Troops and dragoons block each other in a row. They walk through cannons, and cannons block other cannons." },
    ],
    draw: drawUnits,
  },
  {
    title: "Orders",
    artHeight: 320,
    blocks: [
      { kind: "p", text: "Click a unit and the whole line takes the order. Clicking cycles advance, then halt, then reform. One more click advances again." },
      {
        kind: "ul",
        items: [
          "Advance: walk and shoot.",
          "Halt: hold still.",
          "Reform: move at half speed. The front stops until the rear walks into a perfect line, and a stopped unit still shoots. A perfect line keeps walking together at half speed. A unit that joins from behind takes the reform order, unless that line already fills every row. A full line keeps its order. A unit walking through it keeps its own order and does not halt, reform, or charge that line.",
          "Charge: drag toward the enemy. No shooting until contact. Troops and skirmishers speed up near a foe. Cannons do not fire. Coming into line charges that line only when it is reforming and still has an open row. A full line never takes another unit's order.",
          "Fall back: drag toward your keep, at half speed, still fighting. The only order that works in melee.",
          "Change row: drag across, one row at a time. They wait if the next row is blocked.",
        ],
      },
    ],
    draw: drawOrders,
  },
  {
    title: "Lines",
    artHeight: 240,
    blocks: [
      { kind: "p", text: "A line is same-type units in neighboring rows, close enough to count as one rank, one per row. An empty row splits them. An order applies to the whole line." },
      { kind: "p", text: "While advancing, a perfect line holds and shoots if anyone in it has opened fire. On reform, the front stops until the rear walks into that line, then the whole line walks at half speed, and a unit joining from behind takes the reform order unless that line already fills every row. A full line keeps its order. A unit walking through it keeps its own order and does not halt, reform, or charge that line. A charger puts a line onto charge only when that line is reforming and still has an open row. A retreat does not spread to matching units it lines up with." },
    ],
    draw: drawLines,
  },
  {
    title: "Fighting",
    artHeight: 250,
    blocks: [
      { kind: "p", text: "A unit opens fire at half range. If someone in its line has already opened fire, the others may shoot to full range. Shots weaken with distance, down to a quarter at maximum range. Melee does not. Yellow numbers are shots, red are melee, and every hit varies by about 10%." },
      { kind: "p", text: "Charge adds 20% damage. Flanking from the next row adds another 20%, and a dragoon's flank is half again as strong. A shot briefly slows an advancing or charging unit to 40% speed. Halt and reform ignore it. Units in melee cannot be shot. An advancing unit steps across to meet an enemy even with it on another row." },
    ],
    draw: drawFighting,
  },
  {
    title: "Gold and land",
    artHeight: 280,
    blocks: [
      { kind: "p", text: "Gold buys units and banks. Land buys upgrades. Each second you get 10 gold, plus 1 per town, plus your share of the top lane and your banks. Land each second is only your share of the bottom lane. An empty lane is split, so you start at 15 gold and 5 land." },
      { kind: "p", text: "Click a town you own. The two speed towns share one rank, and the two armor towns share another. Ranks cost 150 land, then 150 more each time, and stop at five. Speed is +10% move and +5% attack rate. Damage is +10% to every hit. Armor blocks 10% per rank, up to 70%, and cover adds 20% more without passing that cap." },
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
  }

  function hide() {
    overlay.classList.add("hidden");
    book.setAttribute("aria-expanded", "false");
  }

  function show() {
    const wasHidden = overlay.classList.contains("hidden");
    if (wasHidden && onOpen) onOpen();
    overlay.classList.remove("hidden");
    book.setAttribute("aria-expanded", "true");
    render();
    requestAnimationFrame(paint);
    if (wasHidden) overlay.focus();
  }

  book.addEventListener("click", show);
  close.addEventListener("click", hide);
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
