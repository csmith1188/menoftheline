import { CONFIG } from "../shared/config.js";
import { UNIT_LABELS, unitStats, variantBadgeFill } from "../shared/units.js";
import {
  UNIT_SUMMARIES,
  unitAbilityLines,
  unitArtType,
  unitBasicStats,
  unitEconomy,
  unitIconType,
} from "../shared/unitInfo.js";
import { buyBgSrc } from "./buyArt.js";

/**
 * Full-screen unit info dialog opened by long-pressing a buy button.
 * Match continues underneath (same as How to play).
 */
export function bindUnitInfo(options) {
  const onOpen = options && options.onOpen;
  const overlay = document.getElementById("unit-info");
  if (!overlay) {
    return { open() {}, close() {}, isOpen() { return false; } };
  }
  const title = document.getElementById("unit-info-title");
  const economyEl = document.getElementById("unit-info-economy");
  const art = document.getElementById("unit-info-art");
  const icon = document.getElementById("unit-info-icon");
  const summary = document.getElementById("unit-info-summary");
  const statsEl = document.getElementById("unit-info-stats");
  const abilities = document.getElementById("unit-info-abilities");
  const closeBtn = document.getElementById("unit-info-close");

  function hide() {
    overlay.classList.add("hidden");
  }

  function drawIcon(type) {
    if (!icon) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = 72;
    icon.width = Math.round(css * dpr);
    icon.height = Math.round(css * dpr);
    icon.style.width = `${css}px`;
    icon.style.height = `${css}px`;
    const ctx = icon.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    const boardType = unitIconType(type);
    const stats = unitStats(type);
    const r = Math.min(22, stats.radius * 1.8);
    const x = css / 2;
    const y = css / 2;
    const color = CONFIG.colors.player;
    const badge = variantBadgeFill(type);
    if (badge) {
      const pad = r + 4;
      ctx.fillStyle = badge;
      ctx.fillRect(x - pad, y - pad, pad * 2, pad * 2);
    }

    ctx.fillStyle = color;
    ctx.strokeStyle = "#0d1218";
    ctx.lineWidth = 2;

    if (boardType === "cannon") {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (boardType === "skirmisher") {
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (boardType === "dragoon") {
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (boardType === "officer") {
      const s = r * 0.75;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "#0d1218";
      ctx.beginPath();
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.stroke();
      ctx.restore();
    } else {
      const len = r * 0.9;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineWidth = 12;
      ctx.strokeStyle = "#0d1218";
      ctx.beginPath();
      ctx.moveTo(x - len, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(x - len, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
      ctx.restore();
    }
  }

  function fillStats(type) {
    if (!statsEl) return;
    statsEl.replaceChildren();
    const rows = unitBasicStats(type);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const el = document.createElement("div");
      el.className = "unit-info-stat";
      const label = document.createElement("span");
      label.className = "unit-info-stat-label";
      label.textContent = row.label;
      const track = document.createElement("div");
      track.className = "unit-info-stat-track";
      const fill = document.createElement("div");
      fill.className = "unit-info-stat-fill";
      fill.style.width = `${Math.round(row.ratio * 100)}%`;
      track.appendChild(fill);
      const value = document.createElement("span");
      value.className = "unit-info-stat-value";
      value.textContent = row.display;
      el.append(label, track, value);
      statsEl.appendChild(el);
    }
  }

  function fillAbilities(type) {
    if (!abilities) return;
    abilities.replaceChildren();
    const lines = unitAbilityLines(type);
    if (!lines.length) {
      const empty = document.createElement("li");
      empty.textContent = "No special abilities beyond basic combat stats.";
      abilities.appendChild(empty);
      return;
    }
    for (let i = 0; i < lines.length; i += 1) {
      const li = document.createElement("li");
      li.textContent = lines[i];
      abilities.appendChild(li);
    }
  }

  function populate(type) {
    const label = UNIT_LABELS[type] || type;
    if (title) title.textContent = label;
    if (economyEl) {
      const eco = unitEconomy(type);
      economyEl.textContent = eco.landDisplay
        ? `${eco.costDisplay} · ${eco.landDisplay}`
        : eco.costDisplay;
    }
    if (summary) summary.textContent = UNIT_SUMMARIES[type] || "";
    if (art) {
      const src = buyBgSrc(unitArtType(type));
      if (src) {
        art.src = src;
        art.alt = label;
        art.classList.remove("hidden");
      } else {
        art.removeAttribute("src");
        art.alt = "";
        art.classList.add("hidden");
      }
    }
    drawIcon(type);
    fillStats(type);
    fillAbilities(type);
  }

  function show(type) {
    if (!type) return;
    const wasHidden = overlay.classList.contains("hidden");
    if (wasHidden && onOpen) onOpen();
    populate(type);
    overlay.classList.remove("hidden");
    if (wasHidden) overlay.focus();
  }

  if (closeBtn) closeBtn.addEventListener("click", hide);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) hide();
  });
  document.addEventListener("keydown", (event) => {
    if (overlay.classList.contains("hidden")) return;
    if (event.key === "Escape") hide();
  });

  return {
    open: show,
    close: hide,
    isOpen() {
      return !overlay.classList.contains("hidden");
    },
  };
}
