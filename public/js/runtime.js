/**
 * Shared client runtime: website (cookie/same-origin) vs packaged shells (Bearer + remote server).
 */
import { CLIENT_VERSION, PROTOCOL_VERSION } from "../shared/protocol.js";

const TOKEN_KEY = "motl.sessionToken";
const SERVER_KEY = "motl.serverUrl";

function boot() {
  return (typeof window !== "undefined" && window.MOTL_BOOT) || {};
}

function capacitorNative() {
  if (typeof window === "undefined" || !window.Capacitor) return false;
  if (typeof window.Capacitor.isNativePlatform !== "function") return false;
  try {
    return Boolean(window.Capacitor.isNativePlatform());
  } catch {
    return false;
  }
}

/**
 * True only for explicit packaged clients. Never infer from localStorage
 * motl.serverUrl — a leftover URL made the website use credentials:omit,
 * so /api/v1/me never saw lane.sid while the HTML header still looked logged in.
 */
export function isShell() {
  if (typeof window === "undefined") return false;
  if (window.MOTL_SHELL === true) return true;
  return capacitorNative();
}

function injectedServerUrl() {
  if (typeof window === "undefined") return "";
  const fromWindow = String(window.MOTL_SERVER_URL || "").trim();
  if (fromWindow) return fromWindow.replace(/\/$/, "");
  const fromBoot = String(boot().serverUrl || "").trim();
  if (fromBoot) return fromBoot.replace(/\/$/, "");
  if (!isShell()) return "";
  try {
    const stored = String(localStorage.getItem(SERVER_KEY) || "").trim();
    if (stored) return stored.replace(/\/$/, "");
  } catch {
    // ignore
  }
  return "";
}

/** Remote API base for shells; empty on the website (same-origin relative URLs). */
export function serverUrl() {
  if (!isShell()) return "";
  return injectedServerUrl();
}

/** Drop leftover shell storage so website cookie auth cannot be poisoned. */
function clearWebsiteShellResidue() {
  if (isShell()) return;
  clearToken();
  try {
    localStorage.removeItem(SERVER_KEY);
  } catch {
    // ignore
  }
}

export function siteUrl(pathname = "/") {
  const base = serverUrl() || (typeof window !== "undefined" ? window.location.origin : "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base.replace(/\/$/, "")}${path}`;
}

export function getToken() {
  try {
    return String(localStorage.getItem(TOKEN_KEY) || "").trim() || null;
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, String(token));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function clearToken() {
  setToken(null);
}

export function protocolHeaders() {
  return {
    "x-motl-protocol": String(PROTOCOL_VERSION),
    "x-motl-client": CLIENT_VERSION,
  };
}

/**
 * Fetch against the game API. Shells use Bearer; browsers use credentials cookies.
 * @param {string} path absolute API path e.g. /api/v1/me
 * @param {RequestInit & { json?: unknown }} [opts]
 */
export async function apiFetch(path, opts = {}) {
  const { json, headers: extraHeaders, ...rest } = opts;
  const headers = new Headers(extraHeaders || {});
  headers.set("accept", "application/json");
  for (const [k, v] of Object.entries(protocolHeaders())) headers.set(k, v);
  if (json !== undefined) {
    headers.set("content-type", "application/json");
  }
  // Website auth is the lane.sid cookie. Bearer is for shells only; a leftover
  // motl.sessionToken after login regenerateSession would otherwise win and 401.
  if (isShell()) {
    const token = getToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
  }
  const url = path.startsWith("http") ? path : `${serverUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const init = {
    credentials: isShell() ? "omit" : "include",
    ...rest,
    headers,
  };
  if (json !== undefined) init.body = JSON.stringify(json);
  return fetch(url, init);
}

export async function ensureSession() {
  clearWebsiteShellResidue();
  if (!isShell()) {
    let me = await apiFetch("/api/v1/me");
    if (me.ok) return null;
    const res = await apiFetch("/api/v1/session", { method: "POST", json: {} });
    if (!res.ok) throw new Error(`session_failed_${res.status}`);
    me = await apiFetch("/api/v1/me");
    if (!me.ok) throw new Error(`session_failed_${me.status}`);
    return null;
  }
  const existing = getToken();
  if (existing) {
    const me = await apiFetch("/api/v1/me");
    if (me.ok) return existing;
    clearToken();
  }
  const res = await apiFetch("/api/v1/session", { method: "POST", json: {} });
  if (!res.ok) throw new Error(`session_failed_${res.status}`);
  const data = await res.json();
  if (data.token) setToken(data.token);
  return data.token || null;
}

export async function checkVersion() {
  const res = await apiFetch("/api/v1/version");
  if (!res.ok) return null;
  return res.json();
}

/**
 * @param {object} [extra]
 * @returns {import("socket.io-client").Socket | any}
 */
export function connectSocket(extra = {}) {
  if (typeof window === "undefined" || typeof window.io !== "function") {
    throw new Error("socket.io client not loaded");
  }
  const auth = {
    protocol: PROTOCOL_VERSION,
    clientVersion: CLIENT_VERSION,
    ...extra.auth,
  };
  if (isShell()) {
    const token = getToken();
    if (token) auth.token = token;
  }
  const opts = {
    transports: ["websocket", "polling"],
    ...extra,
    auth: { ...auth, ...(extra.auth || {}) },
  };
  const base = serverUrl();
  if (base) return window.io(base, opts);
  return window.io(opts);
}

export function gamesPath() {
  if (isShell()) return "/app/games.html";
  return "/games";
}

export function playPath(view3d = false) {
  if (isShell()) return view3d ? "/app/play3d.html" : "/app/play.html";
  return view3d ? "/play?view=3d" : "/play";
}

export function lobbyCreatePath(view3d = false) {
  if (isShell()) {
    return view3d ? "/app/lobby-create.html?view=3d" : "/app/lobby-create.html";
  }
  return view3d ? "/games/create?view=3d" : "/games/create";
}

export function goHome() {
  window.location.assign(gamesPath());
}

export function goPlay(view3d = false) {
  window.location.assign(playPath(view3d));
}

/** Open secondary website features (wiki, signup, admin, …). */
export function openExternal(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : siteUrl(pathOrUrl);
  if (window.motlDesktop && typeof window.motlDesktop.openExternal === "function") {
    window.motlDesktop.openExternal(url);
    return;
  }
  if (window.Capacitor?.Plugins?.Browser?.open) {
    window.Capacitor.Plugins.Browser.open({ url }).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
    return;
  }
  if (isShell()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  window.location.assign(url);
}

export function loginUrl(provider = "formbar") {
  const ret = encodeURIComponent("motl://auth");
  if (provider === "discord") {
    return siteUrl(`/api/v1/login/discord?return=${ret}`);
  }
  return siteUrl(`/api/v1/login?return=${ret}`);
}

/** Apply deep-link token from motl://auth?token=… */
export function consumeAuthQuery() {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token) {
      setToken(token);
      params.delete("token");
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash || ""}`;
      window.history.replaceState({}, "", next);
    }
  } catch {
    // ignore
  }
}

export function showOutdated(info) {
  const min = info && info.minProtocol != null ? info.minProtocol : "?";
  const msg = `This client is outdated (need protocol ${min}). Update the app or open the website.`;
  let el = document.getElementById("motl-outdated");
  if (!el) {
    el = document.createElement("div");
    el.id = "motl-outdated";
    el.setAttribute("role", "alert");
    el.style.cssText = "position:fixed;inset:0;z-index:99999;background:#1a1510;color:#f5e6c8;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;padding:2rem;text-align:center;font-family:Georgia,serif;";
    document.body.appendChild(el);
  }
  el.innerHTML = `<p>${msg}</p><p><button type="button" id="motl-outdated-site">Open website</button></p>`;
  const btn = document.getElementById("motl-outdated-site");
  if (btn) {
    btn.onclick = () => openExternal("/");
  }
}

export { PROTOCOL_VERSION, CLIENT_VERSION };
