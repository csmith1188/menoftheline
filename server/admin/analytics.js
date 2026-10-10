import { analyticsSnapshot } from "../db.js";

/** Admin filter categories → games.mode values. */
export const ANALYTICS_CATEGORIES = Object.freeze([
  { id: "tutorials", mode: "training", label: "Tutorials" },
  { id: "bot", mode: "bot", label: "Bot" },
  { id: "casual", mode: "casual", label: "Casual" },
  { id: "custom", mode: "listed", label: "Custom" },
  { id: "ranked", mode: "ranked", label: "Ranked" },
]);

const CATEGORY_BY_ID = new Map(ANALYTICS_CATEGORIES.map((c) => [c.id, c]));
const LABEL_BY_MODE = new Map(ANALYTICS_CATEGORIES.map((c) => [c.mode, c.label]));

/** Friendly label for a persisted games.mode value. */
export function analyticsModeLabel(mode) {
  const key = String(mode || "");
  return LABEL_BY_MODE.get(key) || key || "?";
}

/**
 * Parse ?cat= query (string | string[] | missing).
 * Missing / empty / all selected → no SQL mode filter (all games).
 */
export function parseAnalyticsCategories(raw) {
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const ids = [...new Set(list.map((v) => String(v)).filter((id) => CATEGORY_BY_ID.has(id)))];
  const allIds = ANALYTICS_CATEGORIES.map((c) => c.id);
  if (!ids.length || ids.length === allIds.length) {
    return { ids: allIds, modes: null, all: true };
  }
  return {
    ids,
    modes: ids.map((id) => CATEGORY_BY_ID.get(id).mode),
    all: false,
  };
}

export async function buildAnalytics(range = "30d", categories = null) {
  const allowed = new Set(["24h", "7d", "30d", "90d", "all"]);
  const key = allowed.has(range) ? range : "30d";
  const parsed = parseAnalyticsCategories(categories);
  const snap = await analyticsSnapshot(key, { modes: parsed.modes });
  return {
    ...snap,
    categories: parsed,
    games: {
      ...snap.games,
      byMode: (snap.games?.byMode || []).map((row) => ({
        ...row,
        mode: analyticsModeLabel(row.mode),
      })),
    },
    balance: {
      ...snap.balance,
      winByMode: (snap.balance?.winByMode || []).map((row) => ({
        ...row,
        mode: analyticsModeLabel(row.mode),
      })),
    },
  };
}

export function barRows(items, valueKey = "n", labelKey = "label") {
  const rows = (items || []).map((item) => ({
    label: item[labelKey] != null ? String(item[labelKey]) : String(item.mode || item.day || item.bucket || "?"),
    value: Number(item[valueKey]) || 0,
  }));
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;
  return rows.map((r) => ({
    ...r,
    pct: Math.round((r.value / max) * 100),
  }));
}

/** Format a rate 0–1 as percent string, or em dash when null/unmeasurable. */
export function formatRate(rate) {
  if (rate == null || !Number.isFinite(Number(rate))) return "—";
  return `${(Number(rate) * 100).toFixed(1)}%`;
}

export function formatUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `$${Number(n).toFixed(2)}`;
}
