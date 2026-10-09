/**
 * End-of-match Match Review panel (reuses server matchSummary shape).
 */
import { UNIT_LABELS } from "../shared/units.js";
import { viewMatchReview } from "../shared/matchReview.js";

export { viewMatchReview };

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unitLabel(type) {
  return UNIT_LABELS[type] || type;
}

function formatDuration(elapsedSec) {
  const n = Number(elapsedSec);
  if (!Number.isFinite(n) || n < 0) return "—";
  const total = Math.floor(n);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function countList(counts) {
  if (!counts || typeof counts !== "object") return "—";
  const parts = Object.entries(counts)
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])))
    .map(([type, n]) => `${escapeHtml(unitLabel(type))} ×${Number(n)}`);
  return parts.length ? parts.join(", ") : "—";
}

function upgradeList(ups) {
  if (!ups || typeof ups !== "object") return "—";
  const parts = ["speed", "armor", "damage"]
    .filter((k) => (Number(ups[k]) || 0) > 0)
    .map((k) => `${k} ${Number(ups[k])}`);
  return parts.length ? parts.join(" · ") : "none";
}

function sideBlock(title, side) {
  const s = side || {};
  const dmgOut = Math.round(Number(s.dmgDealt) || 0);
  const dmgIn = Math.round(Number(s.dmgTaken) || 0);
  const kills = Math.round(Number(s.kills) || 0);
  const gold = Math.round(Number(s.goldSpent) || 0);
  const eff = gold > 0 ? (dmgOut / gold).toFixed(2) : "—";
  return `
    <div class="match-review-side">
      <h4>${escapeHtml(title)}</h4>
      <dl>
        <div><dt>Gold spent</dt><dd>${gold}</dd></div>
        <div><dt>Damage</dt><dd>${dmgOut} / ${dmgIn}</dd></div>
        <div><dt>Kills</dt><dd>${kills}</dd></div>
        <div><dt>Dmg / gold</dt><dd>${eff}</dd></div>
        <div class="wide"><dt>Bought</dt><dd>${countList(s.bought)}</dd></div>
        <div class="wide"><dt>Survived</dt><dd>${countList(s.survived)}</dd></div>
        <div class="wide"><dt>Upgrades</dt><dd>${escapeHtml(upgradeList(s.upgrades))}</dd></div>
      </dl>
    </div>
  `;
}

/**
 * Fill `#match-review` (or clear/hide when no summary).
 */
export function syncMatchReview(el, {
  summary,
  elapsed,
  youName = "You",
  oppName = "Opponent",
} = {}) {
  if (!el) return;
  if (!summary || !summary.sides) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const map = summary.mapId ? escapeHtml(summary.mapId) : "—";
  el.classList.remove("hidden");
  el.innerHTML = `
    <p class="match-review-meta">
      <span>Match review</span>
      <span>${formatDuration(elapsed)}</span>
      <span>${map}</span>
    </p>
    <div class="match-review-cols">
      ${sideBlock(youName || "You", summary.sides.player)}
      ${sideBlock(oppName || "Opponent", summary.sides.enemy)}
    </div>
  `;
}
