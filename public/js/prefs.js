import {
  PREFS_BGM_COOKIE,
  PREFS_BGM_DEFAULT,
  PREFS_TOOLTIPS_COOKIE,
  clampPrefsBgmPercent,
} from "../shared/prefs.js";

const MAX_AGE_SEC = 14 * 24 * 60 * 60;

function writeCookie(name, value) {
  try {
    const secure = typeof location !== "undefined" && location.protocol === "https:"
      ? "; Secure"
      : "";
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
      + `; Path=/; Max-Age=${MAX_AGE_SEC}; SameSite=Lax${secure}`;
  } catch {
    // Cookie writes can fail in locked-down browsers; in-memory prefs still apply.
  }
}

/** Persist gesture-tooltip preference for guests (and keep cookies synced when logged in). */
export function writeTooltipsPref(on) {
  writeCookie(PREFS_TOOLTIPS_COOKIE, on ? "1" : "0");
}

/** Persist BGM slider percent (0–100) to a cookie. */
export function writeBgmVolumePref(percent) {
  writeCookie(PREFS_BGM_COOKIE, String(clampPrefsBgmPercent(percent)));
}

export { PREFS_BGM_DEFAULT };
