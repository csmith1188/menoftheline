import { analyticsSnapshot } from "../db.js";

export async function buildAnalytics(range = "30d") {
  const allowed = new Set(["24h", "7d", "30d", "90d", "all"]);
  const key = allowed.has(range) ? range : "30d";
  return analyticsSnapshot(key);
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
