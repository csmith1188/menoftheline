import cookie from "cookie";
import {
  PREFS_BGM_COOKIE,
  PREFS_BGM_DEFAULT,
  PREFS_TOOLTIPS_COOKIE,
  PREFS_TOOLTIPS_DEFAULT,
  parsePrefsBgm,
  parsePrefsTooltips,
} from "../shared/prefs.js";
import { SESSION_MAX_AGE_MS, httpsDeployment } from "./hardening.js";

function cookieOptions(thisUrl) {
  return {
    path: "/",
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
    sameSite: "lax",
    // Client writes these during a match (socket has no Set-Cookie).
    httpOnly: false,
    secure: httpsDeployment(thisUrl),
  };
}

/** Read tooltips / BGM prefs from the request Cookie header. */
export function readPrefsCookies(req) {
  const header = req && req.headers && req.headers.cookie;
  const parsed = header ? cookie.parse(header) : {};
  const tooltips = parsePrefsTooltips(parsed[PREFS_TOOLTIPS_COOKIE]);
  const bgmVolume = parsePrefsBgm(parsed[PREFS_BGM_COOKIE]);
  return {
    tooltips: tooltips == null ? PREFS_TOOLTIPS_DEFAULT : tooltips,
    bgmVolume: bgmVolume == null ? PREFS_BGM_DEFAULT : bgmVolume,
    hasTooltips: tooltips != null,
    hasBgm: bgmVolume != null,
  };
}

/**
 * Write preference cookies. Logged-in loads should pass DB values so they
 * overwrite any prior guest cookies.
 */
export function writePrefsCookies(res, prefs, thisUrl) {
  if (!res || typeof res.append !== "function") return;
  const opts = cookieOptions(thisUrl);
  const tooltips = prefs && prefs.tooltips === false ? false : true;
  const bgmVolume = parsePrefsBgm(prefs && prefs.bgmVolume);
  const bgm = bgmVolume == null ? PREFS_BGM_DEFAULT : bgmVolume;
  res.append("Set-Cookie", cookie.serialize(PREFS_TOOLTIPS_COOKIE, tooltips ? "1" : "0", opts));
  res.append("Set-Cookie", cookie.serialize(PREFS_BGM_COOKIE, String(bgm), opts));
}
