/**
 * Export match graphics as transparent PNGs into public/img/.
 *
 * Usage: node scripts/export-graphics.js [outDir]
 * Default out: public/img
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { CONFIG } from "../shared/config.js";
import { resolveMapFeatures } from "../shared/maps.js";
import { Path, quarterSegments, quarterThickness } from "../shared/path.js";
import { getMap } from "../shared/map/index.js";
import { TERRAIN_EMOJI, TERRAIN_TINT } from "../shared/terrain.js";
import {
  BUY_UNITS,
  UNIT_VARIANTS,
  unitStats,
  variantBadgeFill,
} from "../shared/units.js";

const MAP_ID = "default";
const MIN_SIZE = 128;
const OUT_ROOT = path.resolve(process.argv[2] || "public/img");

registerEmojiFont();

function registerEmojiFont() {
  const candidates = [
    "C:/Windows/Fonts/seguiemj.ttf",
    "C:/Windows/Fonts/SegoeUIEmoji.ttf",
    "/System/Library/Fonts/Apple Color Emoji.ttc",
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      GlobalFonts.registerFromPath(file, "Emoji");
      return;
    } catch {
      /* try next */
    }
  }
}

function emojiFont(px) {
  return `${Math.round(px)}px Emoji, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif`;
}

function installDefaultMap() {
  const map = getMap(MAP_ID);
  if (!map) throw new Error(`Unknown map: ${MAP_ID}`);
  Path.useBoard(map.boardContext());
  return map;
}

function isArcLane(laneId) {
  const def = Path.laneDef(laneId);
  if (def && def.geometry) return def.geometry.kind === "arc";
  return laneId === "bottom";
}

function laneStrokeWidth(laneId) {
  const def = Path.laneDef(laneId);
  if (def && def.geometry && def.geometry.sublaneWidth != null) {
    return def.geometry.sublaneWidth;
  }
  return isArcLane(laneId) ? CONFIG.bottomSublaneWidth : CONFIG.topSublaneWidth;
}

function laneRowColor(laneId) {
  return isArcLane(laneId) ? CONFIG.colors.bottomSublane : CONFIG.colors.topSublane;
}

function strokeLaneInterval(ctx, lane, sublane, minPaces, maxPaces) {
  const total = Path.lanePaces(lane);
  if (!(total > 0) || !(maxPaces > minPaces)) return;
  const t0 = Math.max(0, minPaces / total);
  const t1 = Math.min(1, maxPaces / total);
  if (!(t1 > t0)) return;
  const pts = Path.worldPoints(lane, sublane);
  const steps = isArcLane(lane) ? Math.max(2, Math.ceil((t1 - t0) * 24)) : 1;
  ctx.beginPath();
  for (let k = 0; k <= steps; k += 1) {
    const t = t0 + ((t1 - t0) * k) / steps;
    const p = Path.pointAt(pts, t);
    if (k === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function drawKeeps(ctx) {
  const board = Path.activeBoard();
  const sides = [
    {
      c: board.playerCapital,
      color: CONFIG.colors.player,
      dark: CONFIG.colors.playerDark,
    },
    {
      c: board.enemyCapital,
      color: CONFIG.colors.enemy,
      dark: CONFIG.colors.enemyDark,
    },
  ];
  const r = board.capitalRadius || CONFIG.capitalRadius;
  for (let i = 0; i < sides.length; i += 1) {
    const { c, color, dark } = sides[i];
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.x, c.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function drawLanes(ctx, { onlyLane = null } = {}) {
  const board = Path.activeBoard();
  const left = board.playerCapital;
  const right = board.enemyCapital;
  const ids = Path.laneIds().filter((id) => !onlyLane || id === onlyLane);

  for (let i = 0; i < ids.length; i += 1) {
    const def = Path.laneDef(ids[i]);
    if (!def || !def.geometry || def.geometry.kind !== "line") continue;
    const height = def.geometry.height || CONFIG.topLaneHeight;
    ctx.fillStyle = CONFIG.colors.topLane;
    ctx.fillRect(left.x, left.y - height / 2, right.x - left.x, height);
  }

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (let i = 0; i < ids.length; i += 1) {
    const lane = ids[i];
    const count = Path.sublaneCount(lane);
    ctx.strokeStyle = laneRowColor(lane);
    ctx.lineWidth = laneStrokeWidth(lane);
    for (let s = 0; s < count; s += 1) {
      strokeLaneInterval(ctx, lane, s, 0, Path.lanePaces(lane));
    }
  }

  if (!onlyLane) {
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
  } else if (!isArcLane(onlyLane)) {
    const segs = quarterSegments().filter((s) => {
      const midY = (s.y1 + s.y2) / 2;
      const band = (Path.laneDef(onlyLane)?.geometry?.height || CONFIG.topLaneHeight) / 2;
      return Math.abs(midY - left.y) <= band + 8;
    });
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
  }
}

function drawTerrain(ctx, features, { onlyLane = null } = {}) {
  if (!features.length) return;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (onlyLane && f.lane !== onlyLane) continue;
    const total = Path.lanePaces(f.lane);
    if (!(total > 0)) continue;
    const half = f.halfWidthPaces || 0;
    const tint = TERRAIN_TINT[f.kind] || "rgba(80,80,80,0.7)";
    const width = laneStrokeWidth(f.lane);
    const emoji = f.emoji || TERRAIN_EMOJI[f.kind] || "";
    for (let s = 0; s < f.sublanes.length; s += 1) {
      const sub = f.sublanes[s];
      ctx.lineWidth = width;
      ctx.strokeStyle = tint;
      ctx.globalAlpha = 1;
      strokeLaneInterval(ctx, f.lane, sub, f.centerPaces - half, f.centerPaces + half);
      if (!emoji) continue;
      const mid = Path.pointAt(
        Path.worldPoints(f.lane, sub),
        Math.max(0, Math.min(1, f.centerPaces / total)),
      );
      ctx.globalAlpha = 0.95;
      ctx.font = emojiFont(width * 1.1);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#111";
      ctx.fillText(emoji, mid.x, mid.y);
    }
  }
  ctx.restore();
}

function townUpgradeKind(index, count) {
  const last = count - 1;
  const dist = Math.min(index, last - index);
  if (dist === 0) return "armor";
  if (dist === 1) return "speed";
  return "damage";
}

function townPositions(map) {
  const out = [];
  const specs = map.towns();
  for (let s = 0; s < specs.length; s += 1) {
    const spec = specs[s];
    if (spec.placement !== "innerArc") continue;
    const lane = map.lane(spec.laneId);
    if (!lane || lane.geometry.kind !== "arc") continue;
    const center = Path.arcCenter(spec.laneId);
    const innerEdge = Path.arcRadius(spec.laneId, lane.geometry.sublaneCount - 1)
      - lane.geometry.sublaneWidth / 2;
    const townR = CONFIG.checkpointRadius * CONFIG.uiScale;
    const radius = innerEdge - townR + CONFIG.checkpointLaneOverlap;
    const count = spec.count;
    for (let i = 0; i < count; i += 1) {
      const t = (i + 1) / (count + 1);
      const theta = Math.PI * (1 - t);
      out.push({
        index: i,
        count,
        laneId: spec.laneId,
        x: center.x + radius * Math.cos(theta),
        y: center.y + radius * Math.sin(theta),
        r: townR,
        kind: townUpgradeKind(i, count),
      });
    }
  }
  return out;
}

function drawTowns(ctx, towns) {
  for (let i = 0; i < towns.length; i += 1) {
    const town = towns[i];
    ctx.beginPath();
    ctx.arc(town.x, town.y, town.r, 0, Math.PI * 2);
    ctx.fillStyle = CONFIG.colors.neutral;
    ctx.fill();
    ctx.lineWidth = 3 * CONFIG.uiScale;
    ctx.strokeStyle = "#0d1218";
    ctx.stroke();

    const label = town.kind === "speed" ? "⚡" : town.kind === "armor" ? "🛡️" : "⚔️";
    ctx.fillStyle = "#0d1218";
    ctx.font = emojiFont(10 * CONFIG.uiScale);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, town.x, town.y);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writePng(file, canvas) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, canvas.toBuffer("image/png"));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${canvas.width}x${canvas.height})`);
}

/** Alpha-trim canvas to opaque content; enlarge so both sides are ≥ minSize. */
function cropToContent(canvas, { pad = 1, minSize = MIN_SIZE } = {}) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    const empty = createCanvas(minSize, minSize);
    return empty;
  }

  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;

  const scale = Math.max(1, minSize / Math.min(cw, ch));
  const outW = Math.max(minSize, Math.ceil(cw * scale));
  const outH = Math.max(minSize, Math.ceil(ch * scale));
  const out = createCanvas(outW, outH);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.drawImage(canvas, minX, minY, cw, ch, 0, 0, outW, outH);
  return out;
}

function paintBoard(opts) {
  const board = Path.activeBoard();
  const canvas = createCanvas(board.canvasWidth, board.canvasHeight);
  const ctx = canvas.getContext("2d");
  // Transparent — no background fill.
  ctx.clearRect(0, 0, board.canvasWidth, board.canvasHeight);
  drawLanes(ctx, { onlyLane: opts.onlyLane });
  if (opts.terrain) {
    drawTerrain(ctx, opts.features, { onlyLane: opts.onlyLane });
  }
  if (opts.towns) drawTowns(ctx, opts.towns);
  drawKeeps(ctx);
  return canvas;
}

function exportLanes(map, features, towns) {
  const dir = path.join(OUT_ROOT, "lanes");
  const jobs = [
    ["top.png", { onlyLane: "top", terrain: false, towns: null }],
    ["bottom.png", { onlyLane: "bottom", terrain: false, towns }],
    ["top-terrain.png", { onlyLane: "top", terrain: true, towns: null }],
    ["bottom-terrain.png", { onlyLane: "bottom", terrain: true, towns }],
  ];
  for (let i = 0; i < jobs.length; i += 1) {
    const [name, opts] = jobs[i];
    const full = paintBoard({ ...opts, features });
    writePng(path.join(dir, name), cropToContent(full));
  }
}

function unitCatalog() {
  const list = [];
  for (let i = 0; i < BUY_UNITS.length; i += 1) {
    const base = BUY_UNITS[i].type;
    const alts = UNIT_VARIANTS[base] || [];
    list.push({ key: base, type: base, variant: null, tier: "base" });
    if (alts[0]) list.push({ key: alts[0], type: base, variant: alts[0], tier: "elite" });
    if (alts[1]) list.push({ key: alts[1], type: base, variant: alts[1], tier: "light" });
  }
  return list;
}

function drawUnit(ctx, unit, { bars = false } = {}) {
  const color = unit.side === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
  const spawn = unit.variant || unit.type;
  const stats = unitStats(spawn);
  const r = stats.radius;
  const x = unit.x;
  const y = unit.y;

  ctx.strokeStyle = "#0d1218";
  ctx.lineWidth = 2;

  const badge = variantBadgeFill(spawn);
  if (badge) {
    const pad = r - 1;
    ctx.fillStyle = badge;
    ctx.fillRect(x - pad, y - pad, pad * 2, pad * 2);
  }

  ctx.fillStyle = color;
  if (unit.type === "cannon") {
    ctx.beginPath();
    ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
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
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s);
    ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s);
    ctx.lineTo(x - s, y + s);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s);
    ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s);
    ctx.lineTo(x - s, y + s);
    ctx.stroke();
    ctx.restore();
  } else {
    const nx = 0;
    const ny = -1;
    const len = r * 0.6;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(x - nx * len, y - ny * len);
    ctx.lineTo(x + nx * len, y + ny * len);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.restore();
  }

  if (!bars) return;

  const barW = r * 2;
  const barH = 3;
  const barGap = 1;
  const stackH = barH + barGap + barH;
  const stackTop = y - stackH / 2 + 2;
  const ratio = unit.hpRatio != null ? unit.hpRatio : 0.72;
  const fatigueRatio = unit.fatigueRatio != null ? unit.fatigueRatio : 0.38;
  const barX = x - barW / 2;
  const barY = stackTop;
  ctx.fillStyle = "#1a1510";
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = CONFIG.colors.gold;
  ctx.fillRect(barX, barY, barW * ratio, barH);
  const fatY = barY + barH + barGap;
  ctx.fillStyle = "#1a1510";
  ctx.fillRect(barX, fatY, barW, barH);
  ctx.fillStyle = CONFIG.colors.fatigue;
  ctx.fillRect(barX, fatY, barW * fatigueRatio, barH);
}

function exportUnits() {
  const plainDir = path.join(OUT_ROOT, "units", "plain");
  const barsDir = path.join(OUT_ROOT, "units", "bars");
  const catalog = unitCatalog();
  // Draw large on a transparent canvas, then alpha-crop (and upscale to ≥128).
  const stage = 256;
  const scale = 8;

  for (let i = 0; i < catalog.length; i += 1) {
    const entry = catalog[i];
    for (const withBars of [false, true]) {
      const canvas = createCanvas(stage, stage);
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, stage, stage);
      ctx.save();
      ctx.translate(stage / 2, stage / 2);
      ctx.scale(scale, scale);
      drawUnit(
        ctx,
        {
          x: 0,
          y: 0,
          side: "player",
          type: entry.type,
          variant: entry.variant,
          hpRatio: 0.72,
          fatigueRatio: 0.38,
        },
        { bars: withBars },
      );
      ctx.restore();

      const dir = withBars ? barsDir : plainDir;
      writePng(path.join(dir, `${entry.key}.png`), cropToContent(canvas));
    }
  }
}

function main() {
  const map = installDefaultMap();
  const features = resolveMapFeatures(MAP_ID, { forts: true });
  const towns = townPositions(map);

  ensureDir(OUT_ROOT);
  exportLanes(map, features, towns);
  exportUnits();

  console.log(`\nDone → ${path.relative(process.cwd(), OUT_ROOT)}`);
}

main();
