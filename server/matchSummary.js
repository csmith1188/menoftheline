/**
 * Compact end-of-match summary for admin balance analytics (no PII).
 */
import { UNIT_STATS } from "../shared/units.js";

function countByType(troops) {
  const out = {};
  if (!Array.isArray(troops)) return out;
  for (let i = 0; i < troops.length; i += 1) {
    const t = troops[i];
    if (!t || !(t.hp > 0)) continue;
    const type = t.type || "troop";
    out[type] = (out[type] || 0) + 1;
  }
  return out;
}

function goldSpentFromBought(bought) {
  let gold = 0;
  if (!bought || typeof bought !== "object") return 0;
  for (const [type, n] of Object.entries(bought)) {
    const count = Number(n) || 0;
    if (count <= 0) continue;
    const cost = Number(UNIT_STATS[type]?.cost) || 0;
    gold += cost * count;
  }
  return gold;
}

function copyCounts(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k] = Math.round(n);
  }
  return out;
}

function sideSummary(side) {
  const bought = copyCounts(side && side.bought);
  const upgrades = side && side.upgrades
    ? {
      speed: Number(side.upgrades.speed) || 0,
      armor: Number(side.upgrades.armor) || 0,
      damage: Number(side.upgrades.damage) || 0,
    }
    : { speed: 0, armor: 0, damage: 0 };
  return {
    bought,
    survived: countByType(side && side.troops),
    upgrades,
    dmgDealt: Math.round(Number(side?.dmgDealt) || 0),
    dmgTaken: Math.round(Number(side?.dmgTaken) || 0),
    kills: Math.round(Number(side?.kills) || 0),
    goldSpent: goldSpentFromBought(bought),
    dmgDealtByType: copyCounts(side && side.dmgDealtByType),
    dmgTakenByType: copyCounts(side && side.dmgTakenByType),
    killsByType: copyCounts(side && side.killsByType),
  };
}

/** Build JSON-serializable match summary from a live GameSim. */
export function buildMatchSummary(sim) {
  if (!sim) return null;
  return {
    mapId: sim.mapId || null,
    fog: Boolean(sim.fogEnabled),
    forts: sim.fortsEnabled !== false,
    sides: {
      player: sideSummary(sim.player),
      enemy: sideSummary(sim.enemy),
    },
  };
}

export function matchSummaryJson(sim) {
  const summary = buildMatchSummary(sim);
  if (!summary) return null;
  try {
    return JSON.stringify(summary);
  } catch {
    return null;
  }
}

/** True when win_reason is an intentional or connection forfeit. */
export function isForfeitWinReason(winReason) {
  return winReason === "concede"
    || winReason === "disconnect"
    || winReason === "reconnect_spam";
}

export function outcomeFromWinReason(winReason) {
  if (winReason === "admin") return "admin_cancel";
  if (isForfeitWinReason(winReason)) return "forfeit";
  return "completed";
}

const PLATFORMS = new Set(["web", "electron", "android", "ios", "unknown"]);

export function normalizeClientPlatform(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (PLATFORMS.has(s)) return s;
  return "unknown";
}
