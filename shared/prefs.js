/** Cookie names for guest (and synced account) play preferences. */
export const PREFS_TOOLTIPS_COOKIE = "motl.tooltips";
export const PREFS_BGM_COOKIE = "motl.bgm";

export const PREFS_TOOLTIPS_DEFAULT = true;
export const PREFS_BGM_DEFAULT = 50;

/** Clamp music slider percent (0–100). */
export function clampPrefsBgmPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return PREFS_BGM_DEFAULT;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function parsePrefsTooltips(raw) {
  if (raw == null || raw === "") return null;
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return null;
}

export function parsePrefsBgm(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clampPrefsBgmPercent(n);
}
