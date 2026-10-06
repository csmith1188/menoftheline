import { CONFIG } from "../shared/config.js";
import { resolveMapFeatures } from "../shared/maps.js";
import { Path, quarterSegments, quarterThickness } from "../shared/path.js";
import { TERRAIN_EMOJI, TERRAIN_TINT } from "../shared/terrain.js";

function strokeLaneInterval(ctx, lane, sublane, minPaces, maxPaces) {
  const total = Path.lanePaces(lane);
  if (!(total > 0) || !(maxPaces > minPaces)) return;
  const t0 = Math.max(0, minPaces / total);
  const t1 = Math.min(1, maxPaces / total);
  if (!(t1 > t0)) return;
  const pts = Path.worldPoints(lane, sublane);
  const steps = lane === "bottom" ? Math.max(2, Math.ceil((t1 - t0) * 24)) : 1;
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
  const keeps = [
    { c: CONFIG.playerCapital, color: CONFIG.colors.player },
    { c: CONFIG.enemyCapital, color: CONFIG.colors.enemy },
  ];
  for (let i = 0; i < keeps.length; i += 1) {
    const { c, color } = keeps[i];
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(c.x, c.y, CONFIG.capitalRadius * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLanes(ctx) {
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

  const drawRows = (lane, count, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (let s = 0; s < count; s += 1) {
      strokeLaneInterval(ctx, lane, s, 0, Path.lanePaces(lane));
    }
  };
  drawRows("top", CONFIG.topSublaneCount, CONFIG.colors.topSublane, CONFIG.topSublaneWidth);
  drawRows("bottom", CONFIG.bottomSublaneCount, CONFIG.colors.bottomSublane, CONFIG.bottomSublaneWidth);

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
}

function drawTerrain(ctx, features) {
  if (!features.length) return;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    const total = Path.lanePaces(f.lane);
    if (!(total > 0)) continue;
    const half = f.halfWidthPaces || 0;
    const tint = TERRAIN_TINT[f.kind] || "rgba(80,80,80,0.4)";
    const width = f.lane === "top" ? CONFIG.topSublaneWidth : CONFIG.bottomSublaneWidth;
    const emoji = f.emoji || TERRAIN_EMOJI[f.kind] || "";
    for (let s = 0; s < f.sublanes.length; s += 1) {
      const sub = f.sublanes[s];
      ctx.lineWidth = width;
      ctx.strokeStyle = tint;
      ctx.globalAlpha = 0.55;
      strokeLaneInterval(ctx, f.lane, sub, f.centerPaces - half, f.centerPaces + half);
      if (!emoji) continue;
      const mid = Path.pointAt(
        Path.worldPoints(f.lane, sub),
        Math.max(0, Math.min(1, f.centerPaces / total)),
      );
      ctx.globalAlpha = 0.95;
      ctx.font = `${Math.round(width * 1.1)}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#111";
      ctx.fillText(emoji, mid.x, mid.y);
    }
  }
  ctx.restore();
}

/**
 * Draw a static map preview into `canvas` for the given map / forts settings.
 */
export function drawMapPreview(canvas, { mapId = "default", fortsEnabled = true } = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = CONFIG.canvasWidth;
  const h = CONFIG.canvasHeight;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = CONFIG.colors.bg;
  ctx.fillRect(0, 0, w, h);
  drawLanes(ctx);
  const features = resolveMapFeatures(mapId, { forts: fortsEnabled !== false });
  drawTerrain(ctx, features);
  drawKeeps(ctx);
}

/** Wire selects/checkboxes on a form to live-update a preview canvas. */
export function bindMapPreview(form, canvas) {
  if (!form || !canvas) return;
  const redraw = () => {
    const mapEl = form.elements.namedItem("mapId");
    const fortsEl = form.elements.namedItem("fortsEnabled");
    const mapId = mapEl ? String(mapEl.value) : "default";
    const fortsEnabled = fortsEl ? String(fortsEl.value) !== "0" && String(fortsEl.value) !== "false" : true;
    drawMapPreview(canvas, { mapId, fortsEnabled });
  };
  form.addEventListener("change", redraw);
  redraw();
}
